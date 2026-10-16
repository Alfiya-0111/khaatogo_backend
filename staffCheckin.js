const { classifyCheckIn, classifyCheckOut, resolveShift, isOvernight } = require("./attendanceRules");

const FACE_MATCH_THRESHOLD = 0.45;
const AMBIGUOUS_GAP = 0.05;          // best aur second-best mein itna gap hona chahiye
const DOUBLE_SCAN_WINDOW_MS = 2 * 60 * 1000;

function distanceInMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

// Restaurant ke timezone ki date (YYYY-MM-DD)
function todayInTz(timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}
function yesterdayInTz(timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() - 24 * 3600 * 1000));
}
function registerStaffCheckinRoutes(app, db) {
  app.post("/staff-checkin", async (req, res) => {
    try {
      const { ownerId, descriptor, lat, lng } = req.body || {};

      if (
        typeof ownerId !== "string" || !ownerId ||
        !Array.isArray(descriptor) || descriptor.length !== 128 ||
        !descriptor.every(Number.isFinite) ||
        !Number.isFinite(lat) || !Number.isFinite(lng)
      ) {
        return res.status(400).json({ code: "bad_request", error: "Invalid data" });
      }

      // 1) Geofence — server-side verify
      const rSnap = await db.ref(`restaurants/${ownerId}`).once("value");
      const restaurant = rSnap.val();
      const geo = restaurant?.attendanceGeofence;
      if (!geo?.lat || !geo?.lng) {
        return res.status(400).json({ code: "no_geofence", error: "Restaurant ka location set nahi hai" });
      }
      const timezone = restaurant.timezone || "Asia/Kolkata";
      const dist = distanceInMeters(lat, lng, geo.lat, geo.lng);
      if (dist > (geo.radiusMeters || 100)) {
        return res.status(403).json({ code: "out_of_range", error: "Aap restaurant ke bahar hain" });
      }

      // 2) Face match — staff node se seedha (Admin SDK, rules bypass)
      const staffSnap = await db.ref(`staff/${ownerId}`).once("value");
      const staffData = staffSnap.val() || {};

      const scored = [];
      for (const [id, s] of Object.entries(staffData)) {
        if (!s.faceDescriptor || s.status === "inactive") continue;
        scored.push({ id, staff: s, dist: euclidean(descriptor, s.faceDescriptor) });
      }
      scored.sort((a, b) => a.dist - b.dist);

      const best = scored[0];
      const second = scored[1];
      if (!best || best.dist > FACE_MATCH_THRESHOLD) {
        return res.status(404).json({ code: "no_match", error: "Face match nahi hua" });
      }
      if (second && second.dist - best.dist < AMBIGUOUS_GAP) {
        return res.status(409).json({ code: "ambiguous", error: "Face clear match nahi hua, dobara try karein" });
      }

          // 3) Attendance mark
      const staff = { id: best.id, ...best.staff };
      const shift = resolveShift(staff.shift, restaurant.shifts);
      const now = Date.now();
      const location = { lat, lng };
      const base = `staff/${ownerId}/${staff.id}/attendance`;

      let attDate = todayInTz(timezone);
      let existing = (await db.ref(`${base}/${attDate}`).once("value")).val();

      // Raat paar karne wala shift: check-out agle din hota hai, pichhle din ka open record dhundo
      if (isOvernight(shift) && !(existing && existing.checkIn)) {
        const yDate = yesterdayInTz(timezone);
        const y = (await db.ref(`${base}/${yDate}`).once("value")).val();
        if (y && y.checkIn && !y.checkOut && now - y.checkIn < 16 * 3600 * 1000) {
          attDate = yDate;
          existing = y;
        }
      }

      const attRef = db.ref(`${base}/${attDate}`);

      // Record nahi hai, ya sirf admin/absent job ne status daala hai (checkIn nahi) → check-in
      if (!existing || !existing.checkIn) {
        const status = classifyCheckIn(shift, timezone);
        await attRef.set({ date: attDate, status, checkIn: now, checkInLocation: location });
        return res.json({ status: "ok", kind: "checkin", staffName: staff.name, result: status });
      }

      if (now - existing.checkIn < DOUBLE_SCAN_WINDOW_MS) {
        return res.json({ status: "ok", kind: "already_checkin", staffName: staff.name });
      }

      if (existing.checkOut) {
        return res.json({ status: "ok", kind: "already_done", staffName: staff.name });
      }

      const checkOutStatus = classifyCheckOut(shift, timezone);
      const workedHours = Number(((now - existing.checkIn) / 3600000).toFixed(2));
      await attRef.update({ checkOut: now, checkOutLocation: location, checkOutStatus, workedHours });
      return res.json({ status: "ok", kind: "checkout", staffName: staff.name, result: checkOutStatus });
    } catch (e) {
      console.error("staff-checkin error:", e);
      res.status(500).json({ code: "server", error: "Server error" });
    }
  });
}

module.exports = { registerStaffCheckinRoutes, todayInTz };