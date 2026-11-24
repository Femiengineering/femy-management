# הקמת החיבור לענן (Firebase)

המדריך הזה מחבר את מערכת הניהול לענן: כניסה עם משתמש לכל עובד ונתונים משותפים לכל החברה.
עד שמסיימים את השלבים, האתר ממשיך לעבוד במצב מקומי בדיוק כמו היום.

**עלות:** תוכנית Spark של Firebase חינמית ומספיקה לחברה קטנה (עד 50,000 קריאות ו-20,000 כתיבות ביום, 1GB נתונים). אין צורך בכרטיס אשראי.

זמן משוער: כ-20 דקות.

## 1. יצירת פרויקט

1. נכנסים ל-https://console.firebase.google.com עם חשבון Google של החברה.
2. **Create a project**, שם: `femy-management`. את Google Analytics אפשר לכבות.

## 2. הפעלת שיטות הכניסה

1. בתפריט: **Build › Authentication › Get started**.
2. בלשונית **Sign-in method**:
   - **Google** › Enable › בוחרים מייל תמיכה › Save.
   - **Email/Password** › Enable › Save.
3. בלשונית **Settings › Authorized domains** › **Add domain** › `femiengineering.github.io`.

## 3. יצירת מסד הנתונים

1. **Build › Firestore Database › Create database**.
2. מיקום: `me-west1 (Tel Aviv)` (או `eur3 (Europe)`). שימו לב שאי אפשר לשנות את המיקום אחר כך.
3. בוחרים **Start in production mode**.
4. בלשונית **Rules** מוחקים את מה שיש, ומדביקים את כל התוכן של הקובץ [`firestore.rules`](../firestore.rules) מהמאגר.
5. **לפני הפרסום:** בשורה `function admins() { return ['manager@example.com']; }` מחליפים את `manager@example.com` בכתובת המייל של מנהל המערכת, באותיות קטנות. אפשר כמה מנהלים: `['a@femy.co.il', 'b@femy.co.il']`.
6. **Publish**.

## 4. רישום האתר והעתקת ההגדרות

1. גלגל השיניים ליד **Project Overview** › **Project settings**.
2. למטה, **Your apps** › הסמל `</>` (Web). כינוי: `femy-web`. **לא** לסמן Firebase Hosting. › **Register app**.
3. יופיע קוד עם `const firebaseConfig = { ... }`. מעתיקים ממנו את הערכים.
4. בגיטהב, פותחים את הקובץ [`firebase-config.js`](../firebase-config.js) › עיפרון (Edit), ומחליפים את `window.FEMY_FIREBASE = null;` ב:

```js
window.FEMY_FIREBASE = {
  apiKey: '...',            // מתוך firebaseConfig
  authDomain: '...',        // מתוך firebaseConfig
  projectId: '...',         // מתוך firebaseConfig
  appId: '...',             // מתוך firebaseConfig
  orgId: 'femy',
  admins: ['manager@femy.co.il'],  // אותה כתובת (או כתובות) כמו ב-firestore.rules
};
```

5. **Commit changes**. תוך דקה-שתיים האתר יתעדכן ויציג מסך כניסה.

הערכים האלה אינם סודיים, וזה תקין שהם במאגר ציבורי: מה שמגן על הנתונים הוא כללי האבטחה משלב 3.

## 5. Google יומן, Gmail ו-Drive (רשות)

החיבור ל-Google הוא נפרד מ-Firebase, ועובד גם בלעדיו. ההוראות ב-[GOOGLE-SETUP.md](GOOGLE-SETUP.md). אם כבר הקמתם את פרויקט Firebase, השתמשו באותו פרויקט ב-Google Cloud.

## 6. כניסה ראשונה

1. המנהל נכנס לאתר, "כניסה עם Google" (או הרשמה עם אימייל וסיסמה, ואישור הקישור שמגיע במייל).
2. **הגדרות › משתמשים והרשאות**: מוסיפים את המייל של כל עובד. רק מי שברשימה יכול להיכנס.
3. אם במכשיר של המנהל היו נתונים מלפני המעבר, מופיע בהגדרות כרטיס **"העברת נתונים מהמכשיר הזה לענן"**. לוחצים "הוספה לענן". אם הנתונים במכשיר אחר, נכנסים ממנו ועושים את אותו הדבר.
4. מפתח Claude: כל משתמש מזין בהגדרות. המפתח נשמר בפרופיל הפרטי שלו, ורק הוא יכול לקרוא אותו.

## בעיות נפוצות

- **"auth/unauthorized-domain"**: לא נוסף `femiengineering.github.io` ב-Authorized domains (שלב 2.3).
- **"החשבון עדיין לא אושר"**: המייל לא ברשימת המשתמשים, או שלא תואם בדיוק לזה שבו נכנסו.
- **אייפון, אפליקציה במסך הבית:** אם חלון הכניסה עם Google לא נפתח, אפשר להיכנס עם אימייל וסיסמה, או לפתוח את האתר בספארי.
