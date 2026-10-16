const cron = require("node-cron");
const { todayInTz } = require("./staffCheckin");
const { resolveShift, isOvernight, timeToMinutes, getMinutesInTimezone } = require("./attendanceRules");

const GRACE_AFTER_SHIFT_MIN = 60;

function yesterdayInTz(timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() - 24 * 3600 * 1000));
}

function setupAbsentJob(db) {
  async function markAbsentees() {
    const [staffSnap, restSnap] = await Promise.all([
      db.ref("staff").once("value"),
      db.ref("restaurants").once("value"),
    ]);
    const allStaff = staffSnap.val() || {};
    const restaurants = restSnap.val() || {};

    for (const [ownerId, staffList] of Object.entries(allStaff)) {
      const restaurant = restaurants[ownerId] || {};
      const tz = restaurant.timezone || "Asia/Kolkata";
      const nowMin = getMinutesInTimezone(tz);

      for (const [staffId, s] of Object.entries(staffList)) {
        if (s.status !== "active") continue; // leave/inactive ko absent nahi

        const shift = resolveShift(s.shift, restaurant.shifts);
        const threshold = Math.min(timeToMinutes(shift.end) + GRACE_AFTER_SHIFT_MIN, 1439);
        if (nowMin < threshold) continue; // shift abhi khatam nahi hua

        // Raat wale shift ka din kal shuru hua tha, to kal ki date check hogi
        const date = isOvernight(shift) ? yesterdayInTz(tz) : todayInTz(tz);

        if (s.joinDate && s.joinDate > date) continue; // us din tak join hi nahi kiya tha
        if (s.attendance?.[date]) continue;            // record already hai

        await db.ref(`staff/${ownerId}/${staffId}/attendance/${date}`).set({
          date,
          status: "absent",
        });
        console.log(`Absent marked: ${ownerId}/${staffId} (${date})`);
      }
    }
  }

  cron.schedule("*/15 * * * *", () => {
    markAbsentees().catch((e) => console.error("Absent job error:", e));
  });
}

module.exports = { setupAbsentJob };