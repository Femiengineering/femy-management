// חיבור לחשבון Google של כל משתמש: יומן, Gmail ו-Google Drive.
// כל עוד clientId ריק, החיבור ל-Google כבוי והאתר עובד כרגיל.
// אחרי יצירת OAuth Client ID (ראו docs/GOOGLE-SETUP.md), מדביקים אותו כאן.
// הערך הזה אינו סודי: Google מאשרת רק בקשות שמגיעות מכתובות האתר שהוגדרו לו.
window.FEMY_GOOGLE = {
  clientId: '380692332592-oq3d6q4vkbrnftmm03v4si5co6rptjqe.apps.googleusercontent.com', // לדוגמה: '123456789-abc.apps.googleusercontent.com'
  // חיבור קבוע (בלי התנתקות כל שעה): כתובת שרת החיבור מהתיקייה worker/, ראו docs/GOOGLE-SETUP.md שלב 7.
  // כל עוד ריק, החיבור מתחדש בלחיצה כל שעה בערך.
  // תיקיית הפרויקטים ב-Drive: בלשונית Drive באתר מוצג רק מה שבתוכה.
  projectsFolderName: 'פרויקטים פמי',
  projectsFolderId: '1rb3m55bbrVh0rFku9uRB5GaCBsR-VLCV',
  // גיליון המשימות ("משימות פמי"): המשימות ואנשי הקשר באתר מסונכרנים ממנו כל 10 דקות.
  tasksSheetId: '1kwUxnrAQ6zAz2AkFjsR5rHEIKzQGbjo2_Qr0Sm8gSwQ',
  tokenServer: 'https://femy-google.femy-eng.workers.dev', // לדוגמה: 'https://femy-google.<שם-החשבון>.workers.dev'
};
