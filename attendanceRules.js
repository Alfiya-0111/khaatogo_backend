const DEFAULT_SHIFTS = {
  morning:   { label: "Morning",   start: "06:00", end: "14:00" },
  evening:   { label: "Evening",   start: "14:00", end: "22:00" },
  night:     { label: "Night",     start: "22:00", end: "06:00" },
  full_time: { label: "Full Time", start: "09:00", end: "18:00" },
};

const LATE_GRACE_MINUTES = 15;
const HALF_DAY_AFTER_MINUTES = 120;
const EARLY_LEAVE_BEFORE_MINUTES = 15;
const OVERTIME_AFTER_MINUTES = 30;

function timeToMinutes(t) {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
}

function getMinutesInTimezone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour").value) * 60 +
         Number(parts.find((p) => p.type === "minute").value);
}

// diff ko -12h..+12h ke range mein laao (midnight wrap ke liye)
function normalize(diff) {
  return ((((diff + 720) % 1440) + 1440) % 1440) - 720;
}

function resolveShift(shiftId, customShifts) {
  return (customShifts && customShifts[shiftId]) || DEFAULT_SHIFTS[shiftId] || DEFAULT_SHIFTS.full_time;
}

// end <= start matlab shift raat paar karke agle din khatam hota hai
function isOvernight(shift) {
  return timeToMinutes(shift.end) <= timeToMinutes(shift.start);
}

function classifyCheckIn(shift, timezone = "Asia/Kolkata") {
  const diff = normalize(getMinutesInTimezone(timezone) - timeToMinutes(shift.start));
  if (diff <= LATE_GRACE_MINUTES) return "present"; // jaldi aana bhi present
  if (diff <= HALF_DAY_AFTER_MINUTES) return "late";
  return "half_day";
}

function classifyCheckOut(shift, timezone = "Asia/Kolkata") {
  const diff = normalize(getMinutesInTimezone(timezone) - timeToMinutes(shift.end));
  if (diff < -EARLY_LEAVE_BEFORE_MINUTES) return "early_leave";
  if (diff > OVERTIME_AFTER_MINUTES) return "overtime";
  return "on_time";
}

module.exports = {
  DEFAULT_SHIFTS, resolveShift, isOvernight, timeToMinutes,
  getMinutesInTimezone, classifyCheckIn, classifyCheckOut,
};