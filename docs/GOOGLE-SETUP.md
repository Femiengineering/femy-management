# חיבור המערכת ל-Google: יומן, Gmail ו-Drive

אחרי ההגדרה הזו, כל משתמש באתר לוחץ "חיבור לחשבון Google" ומאשר גישה לחשבון שלו. מכאן הוא רואה במסך **יומן, מייל ו-Drive**:

- **יומן:** האירועים שלו לשבועיים הקרובים, הוספת אירוע חדש (כולל הזמנת משתתפים), הוספת משימה ליומן ביום היעד, והוספת ישיבה מפרוטוקול. בלוח הבקרה מופיע "היומן שלי היום ומחר".
- **Gmail:** המיילים האחרונים בתיבה, חיפוש, שליחת מייל, ויצירת משימה ממייל בלחיצה. שליחת פרוטוקול עם קובץ Word מצורף ישירות מה-Gmail שלו.
- **Drive:** הקבצים האחרונים שלו, חיפוש לפי שם, העלאת קובץ, שמירת פרוטוקולים כ-Word וגיבוי מלא.

**כל משתמש רואה רק את החשבון שלו.** החיבור נשמר בדפדפן של המשתמש בלבד, תחת שם המשתמש שלו באתר, ונמחק כשהוא יוצא מהמערכת. האתר אינו שומר מיילים, אירועים או קבצים בשום מקום.

ההגדרה נעשית פעם אחת, על ידי מנהל המערכת. זמן משוער: כ-15 דקות. אין עלות.

## 1. פרויקט ב-Google Cloud

1. נכנסים ל-https://console.cloud.google.com עם חשבון ה-Google של החברה.
2. למעלה, בבחירת הפרויקט › **New project**. שם: `femy-management` › **Create**. (אם כבר הוקם פרויקט Firebase בשם הזה, בוחרים אותו.)

## 2. הפעלת שלושת ה-API

**APIs & Services › Library**. מחפשים כל אחד מהבאים ולוחצים **Enable**:

- **Google Calendar API**
- **Gmail API**
- **Google Drive API**

## 3. מסך ההסכמה (OAuth consent screen)

**APIs & Services › OAuth consent screen** (בממשק החדש: **Google Auth Platform**).

1. **App name:** `פמי הנדסה - מערכת ניהול`. **User support email:** המייל של המנהל.
2. **Audience / User type:**
   - **אם המייל של החברה (femy.co.il) מנוהל ב-Google Workspace:** בוחרים **Internal**. כל העובדים בדומיין יכולים להתחבר, בלי אישור של Google ובלי הודעות אזהרה. זו האפשרות המומלצת.
   - **אחרת:** בוחרים **External**, משאירים במצב **Testing**, ותחת **Test users** מוסיפים את המייל של כל משתמש (עד 100). במצב הזה Google מציגה בחיבור הראשון הודעה שהאפליקציה לא אומתה. לוחצים "המשך".
3. **Scopes** (או **Data access › Add or remove scopes**). מוסיפים את חמשת אלה:

| הרשאה | למה |
|---|---|
| `.../auth/calendar.events` | הצגת האירועים ביומן והוספת אירועים |
| `.../auth/gmail.readonly` | הצגת המיילים בתיבה |
| `.../auth/gmail.send` | שליחת מייל, רק כשהמשתמש לוחץ ומאשר |
| `.../auth/drive.readonly` | הצגת הקבצים ב-Drive וחיפוש |
| `.../auth/drive.file` | העלאת קבצים ושמירת פרוטוקולים וגיבויים, בתיקייה "פמי הנדסה - מערכת ניהול" |

4. **Save**.

## 4. יצירת OAuth Client ID

1. **APIs & Services › Credentials › Create credentials › OAuth client ID** (או **Google Auth Platform › Clients › Create client**).
2. **Application type:** `Web application`. שם: `femy-web`.
3. **Authorized JavaScript origins** › **Add URI**:
   - `https://femiengineering.github.io`
   - `http://localhost:8000` (רשות, להרצה מקומית)
4. **Authorized redirect URIs:** משאירים ריק.
5. **Create**. מופיע **Client ID** שנראה כך: `123456789-abcdef.apps.googleusercontent.com`. מעתיקים אותו.

## 5. הדבקת ה-Client ID באתר

בגיטהב פותחים את הקובץ [`google-config.js`](../google-config.js) › עיפרון (Edit), ומדביקים בין המירכאות:

```js
window.FEMY_GOOGLE = {
  clientId: '123456789-abcdef.apps.googleusercontent.com',
};
```

**Commit changes**. תוך דקה-שתיים האתר מתעדכן.

ה-Client ID אינו סוד, וזה תקין שהוא במאגר ציבורי: Google מקבלת בקשות איתו רק מהכתובות שהוגדרו בשלב 4.3. אין צורך ב-Client secret, והוא לא נכנס לשום קובץ.

## 6. חיבור של כל משתמש

1. נכנסים לאתר עם המשתמש שלכם.
2. בתפריט: **יומן, מייל ו-Drive** › **חיבור לחשבון Google** (או בהגדרות, "חשבון Google שלי").
3. בוחרים את חשבון ה-Google שלכם ומאשרים את ההרשאות.

החיבור תקף כשעה. אחר כך מופיע כפתור **חידוש החיבור**: לחיצה אחת, בלי לאשר שוב את ההרשאות. בטלפון ובמחשב אחר מתחברים בנפרד.

לניתוק מלא: בהגדרות › "ניתוק", או ב-https://myaccount.google.com/permissions.

## בעיות נפוצות

- **"Error 400: redirect_uri_mismatch" או "origin_mismatch":** הכתובת של האתר לא נוספה ב-Authorized JavaScript origins (שלב 4.3). שימו לב: בלי `/` בסוף ובלי `/femy-management`.
- **"Access blocked: app has not completed the Google verification process":** המשתמש לא ברשימת Test users (שלב 3.2).
- **"אין הרשאה" ביומן, במיילים או ב-Drive:** ה-API לא הופעל (שלב 2), או שבחלון של Google לא סומנו כל ההרשאות. מתנתקים בהגדרות ומתחברים שוב, ומסמנים הכול.
- **החלון של Google לא נפתח:** הדפדפן חוסם חלונות קופצים. מאשרים חלונות קופצים לאתר ולוחצים שוב.
