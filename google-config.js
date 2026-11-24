// חיבור לחשבון Google של כל משתמש: יומן, Gmail ו-Google Drive.
// כל עוד clientId ריק, החיבור ל-Google כבוי והאתר עובד כרגיל.
// אחרי יצירת OAuth Client ID (ראו docs/GOOGLE-SETUP.md), מדביקים אותו כאן.
// הערך הזה אינו סודי: Google מאשרת רק בקשות שמגיעות מכתובות האתר שהוגדרו לו.
window.FEMY_GOOGLE = {
  clientId: '', // לדוגמה: '123456789-abc.apps.googleusercontent.com'
};
