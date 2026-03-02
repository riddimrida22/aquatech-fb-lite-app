import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, RefreshControl, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { WebView } from "react-native-webview";

const APP_BASE_URL = "https://app.aquatechpc.com/?timesheet_only=1";

export default function HomeScreen() {
  const webRef = useRef<WebView>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const allowedHosts = useMemo(() => new Set(["app.aquatechpc.com"]), []);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <WebView
        ref={webRef}
        source={{ uri: APP_BASE_URL }}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        startInLoadingState
        onLoadStart={() => {
          setIsLoading(true);
          setLoadFailed(false);
        }}
        onLoadEnd={() => {
          setIsLoading(false);
          setIsRefreshing(false);
        }}
        onError={() => {
          setIsLoading(false);
          setLoadFailed(true);
          setIsRefreshing(false);
        }}
        onShouldStartLoadWithRequest={(req) => {
          try {
            const url = new URL(req.url);
            if (allowedHosts.has(url.host)) return true;
            Linking.openURL(req.url).catch(() => undefined);
            return false;
          } catch {
            return true;
          }
        }}
        pullToRefreshEnabled
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => {
              setIsRefreshing(true);
              webRef.current?.reload();
            }}
          />
        }
      />
      {isLoading && (
        <View style={styles.overlay}>
          <ActivityIndicator size="large" />
          <Text style={styles.overlayText}>Loading timesheets...</Text>
        </View>
      )}
      {loadFailed && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>Could not load Aquatech Timesheets.</Text>
          <TouchableOpacity
            onPress={() => {
              setLoadFailed(false);
              setIsLoading(true);
              webRef.current?.reload();
            }}
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.9)"
  },
  overlayText: { marginTop: 10, fontSize: 14, color: "#333333" },
  errorBar: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 16,
    backgroundColor: "#fff3f3",
    borderColor: "#f6b5b5",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  errorText: { color: "#8b1e1e", fontSize: 13 },
  retryText: { color: "#0057c2", fontSize: 13, fontWeight: "600" }
});
