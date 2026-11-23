import { useRef } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';

import webAppHtml from './web/bundle';

// The app shows the same management system as the website, bundled inside the
// app so it works without a connection. Data is saved on the phone.
// A fixed base URL keeps the page origin stable, so saved data survives updates.
const BASE_URL = 'https://app.femy.local/';

export default function App() {
  const webRef = useRef(null);

  async function onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    try {
      if (msg.type === 'download') {
        const file = new File(Paths.cache, msg.name);
        file.create({ overwrite: true });
        file.write(msg.text);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(file.uri, { mimeType: msg.mime, dialogTitle: msg.name });
        } else {
          Alert.alert('שמירת קובץ', 'שיתוף קבצים אינו זמין במכשיר זה.');
        }
      } else if (msg.type === 'print') {
        await Print.printAsync({ html: msg.html });
      }
    } catch (e) {
      Alert.alert('שגיאה', String(e && e.message ? e.message : e));
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <StatusBar style="light" backgroundColor="#15253d" />
        <WebView
          ref={webRef}
          style={styles.web}
          originWhitelist={['*']}
          source={{ html: webAppHtml, baseUrl: BASE_URL }}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures={false}
          bounces={false}
          overScrollMode="never"
          textZoom={100}
          keyboardDisplayRequiresUserAction={false}
          onShouldStartLoadWithRequest={(req) => /^(https:\/\/app\.femy\.local\/|about:|data:|blob:)/.test(req.url)}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#15253d' },
  web: { flex: 1, backgroundColor: '#f4f6f9' },
});
