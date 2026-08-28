const cron = require("node-cron");

function setupAbsentJob(db) {
  async function markAbsentees() {
    const today = new Date().toISOString().split("T")[0];
    const staffSnapshot = await db.ref("staff").once("value");
    const allRestaurants = staffSnapshot.val() || {};

    for (const [ownerId, staffList] of Object.entries(allRestaurants)) {
      for (const [staffId, staffData] of Object.entries(staffList)) {
        const hasAttendanceToday = staffData.attendance?.[today];
        if (!hasAttendanceToday) {
          await db.ref(`staff/${ownerId}/${staffId}/attendance/${today}`).set({
            date: today,
            status: "absent",
          });
        }
      }
    }
    console.log(`Absent marking done for ${today}`);
  }

  // Roz raat 11:59 PM (IST) pe chalega
  cron.schedule("59 23 * * *", markAbsentees, { timezone: "Asia/Kolkata" });
}

module.exports = { setupAbsentJob };