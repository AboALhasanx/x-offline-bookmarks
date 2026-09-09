import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { LogBox, StyleSheet, ToastAndroid, View } from 'react-native';

LogBox.ignoreAllLogs(true);
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useShareIntent } from 'expo-share-intent';
import { addPendingItem } from './src/db/db';
import HomeScreen from './src/screens/HomeScreen';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s"')\]]+/);
  return match ? match[0] : null;
}

export default function App() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!hasShareIntent || !shareIntent) return;
    (async () => {
      try {
        const raw = shareIntent.webUrl ?? shareIntent.text ?? '';
        const url = shareIntent.webUrl ?? (raw ? extractUrl(raw) : null) ?? raw;
        if (!url) {
          ToastAndroid.show('Shared content had no URL', ToastAndroid.SHORT);
        } else {
          await addPendingItem(url, raw || null);
          ToastAndroid.show('Saved to queue', ToastAndroid.SHORT);
          setRefreshKey((k) => k + 1);
        }
      } catch {
        ToastAndroid.show('Could not queue share', ToastAndroid.SHORT);
      } finally {
        resetShareIntent();
      }
    })();
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedApp refreshKey={refreshKey} />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function ThemedApp({ refreshKey }: { refreshKey: number }) {
  const { colors, isDark } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={styles.body}>
        <HomeScreen refreshKey={refreshKey} />
      </View>
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { flex: 1, backgroundColor: '#000' },
  body: { flex: 1 },
});
