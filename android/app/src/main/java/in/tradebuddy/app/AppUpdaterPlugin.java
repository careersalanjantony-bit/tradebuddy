package in.tradebuddy.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * In-app updates (app v1.5): downloads a newer TradeBuddy APK from this app's own GitHub releases page,
 * checks it (size, SHA-256, same app, newer version, same signing key) and hands it to Android's
 * installer. Android shows its own "Update" screen and refuses any file not signed with this app's key.
 *
 * Only https://github.com/careersalanjantony-bit/tradebuddy/releases/download/... is accepted.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String ALLOWED_PREFIX = "https://github.com/careersalanjantony-bit/tradebuddy/releases/download/";
    private static final String FILE_NAME = "TradeBuddy-update.apk";
    private static final long MAX_BYTES = 200L * 1024 * 1024;

    private File updateFile() {
        File dir = new File(getContext().getCacheDir(), "updates");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, FILE_NAME);
    }

    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url", "");
        final long expectedSize = call.getLong("size", 0L);
        final String expectedSha = call.getString("sha256", "");
        if (url == null || !url.startsWith(ALLOWED_PREFIX) || !url.endsWith(".apk")) {
            call.reject("Only TradeBuddy's own releases page can be used for updates.");
            return;
        }
        new Thread(() -> {
            File out = updateFile();
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                conn.setRequestProperty("Accept", "application/octet-stream");
                int status = conn.getResponseCode();
                if (status != 200) throw new Exception("The download page answered " + status + ". Try again later.");
                if (!conn.getURL().getProtocol().equals("https")) throw new Exception("The download was not secure (not https).");
                long total = conn.getContentLengthLong();
                if (total > MAX_BYTES) throw new Exception("The file is unexpectedly large.");
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                long done = 0;
                long lastReport = 0;
                try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        os.write(buf, 0, n);
                        sha.update(buf, 0, n);
                        done += n;
                        if (done > MAX_BYTES) throw new Exception("The file is unexpectedly large.");
                        if (done - lastReport > 256 * 1024) {
                            lastReport = done;
                            JSObject p = new JSObject();
                            p.put("done", done);
                            p.put("total", total > 0 ? total : expectedSize);
                            notifyListeners("downloadProgress", p);
                        }
                    }
                }
                if (expectedSize > 0 && done != expectedSize) throw new Exception("The download was incomplete. Try again.");
                String got = hex(sha.digest());
                if (expectedSha != null && !expectedSha.isEmpty() && !expectedSha.equalsIgnoreCase(got)) {
                    throw new Exception("The downloaded file does not match the published check number. Not installed.");
                }
                JSObject res = checkApk(out);
                res.put("sha256", got);
                res.put("bytes", done);
                call.resolve(res);
            } catch (Exception e) {
                out.delete();
                call.reject(e.getMessage() != null ? e.getMessage() : "Download failed.");
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    /** Same app, newer version, signed with a key this app trusts (Android checks the key again). */
    private JSObject checkApk(File f) throws Exception {
        Context ctx = getContext();
        PackageManager pm = ctx.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo apk = pm.getPackageArchiveInfo(f.getAbsolutePath(), flags);
        if (apk == null) throw new Exception("The downloaded file is not a working app file.");
        if (!ctx.getPackageName().equals(apk.packageName)) throw new Exception("The downloaded file is a different app. Not installed.");
        PackageInfo mine = pm.getPackageInfo(ctx.getPackageName(), flags);
        long apkCode = Build.VERSION.SDK_INT >= 28 ? apk.getLongVersionCode() : apk.versionCode;
        long myCode = Build.VERSION.SDK_INT >= 28 ? mine.getLongVersionCode() : mine.versionCode;
        if (apkCode <= myCode) throw new Exception("The downloaded version is not newer than the one you have.");
        Set<String> theirs = certs(apk);
        Set<String> ours = certs(mine);
        // empty = this phone could not read the key from the file; Android's installer still checks it
        if (!theirs.isEmpty() && !ours.isEmpty()) {
            Set<String> both = new HashSet<>(theirs);
            both.retainAll(ours);
            if (both.isEmpty()) throw new Exception("The downloaded file is not signed by TradeBuddy's key. Not installed.");
        }
        JSObject res = new JSObject();
        res.put("versionName", apk.versionName);
        res.put("versionCode", apkCode);
        return res;
    }

    private static Set<String> certs(PackageInfo info) {
        Set<String> out = new HashSet<>();
        try {
            Signature[] sigs = null;
            if (Build.VERSION.SDK_INT >= 28) {
                SigningInfo si = info.signingInfo;
                if (si != null) sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
            } else {
                sigs = info.signatures;
            }
            if (sigs != null) {
                for (Signature s : sigs) out.add(hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray())));
            }
        } catch (Exception ignored) {
            // leave empty: the installer decides
        }
        return out;
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x));
        return sb.toString();
    }

    /** Android 8+: has the owner allowed TradeBuddy to install updates? */
    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean allowed = Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls();
        File f = updateFile();
        JSObject res = new JSObject();
        res.put("allowed", allowed);
        res.put("downloaded", f.exists());
        if (f.exists()) {
            // which version the waiting file is (so an allowed-then-restarted app need not download again)
            PackageInfo apk = getContext().getPackageManager().getPackageArchiveInfo(f.getAbsolutePath(), 0);
            if (apk != null && apk.versionName != null) res.put("downloadedVersion", apk.versionName);
        }
        call.resolve(res);
    }

    /** Opens Android's "Install unknown apps → TradeBuddy → Allow from this source" page. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent i = Build.VERSION.SDK_INT >= 26
                    ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()))
                    : new Intent(Settings.ACTION_SECURITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open the setting. Open Settings → Apps → TradeBuddy → Install unknown apps.");
        }
    }

    /** Hands the checked file to Android's installer, which asks "Do you want to update this app?". */
    @PluginMethod
    public void install(PluginCall call) {
        File f = updateFile();
        if (!f.exists()) {
            call.reject("Download the update first.");
            return;
        }
        try {
            Context ctx = getContext();
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start the installer: " + e.getMessage());
        }
    }

    /** Removes a downloaded update file (after updating, or to free space). */
    @PluginMethod
    public void clear(PluginCall call) {
        updateFile().delete();
        call.resolve();
    }
}
