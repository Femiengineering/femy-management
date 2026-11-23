// הגדרות החיבור לענן (Firebase).
// כל עוד הערך הוא null, האתר עובד במצב מקומי: הנתונים נשמרים רק בדפדפן, כמו קודם.
// אחרי הקמת פרויקט Firebase (ראו docs/FIREBASE-SETUP.md), מחליפים את null בהגדרות.
// הערכים האלה אינם סודיים: Firebase מגן על הנתונים באמצעות כללי האבטחה (firestore.rules).
window.FEMY_FIREBASE = null;

/* דוגמה:
window.FEMY_FIREBASE = {
  apiKey: 'AIza...',
  authDomain: 'femy-xxxx.firebaseapp.com',
  projectId: 'femy-xxxx',
  appId: '1:000000000000:web:xxxxxxxx',
  orgId: 'femy',                    // שם מרחב הנתונים המשותף של החברה
  admins: ['manager@example.com'],  // מנהלי המערכת. חייב להתאים לרשימה בקובץ firestore.rules
};
*/
