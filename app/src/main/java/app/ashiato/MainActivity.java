package app.ashiato;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private static final int REQ_IMPORT = 1;
    private static final int REQ_BACKUP = 2;
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/web/index.html";

    private WebView web;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean pageReady = false;
    private final List<Uri> pendingShared = new ArrayList<>();
    private volatile boolean busy = false;

    private File dataFile() { return new File(getFilesDir(), "locations.json"); }
    private File userFile() { return new File(getFilesDir(), "user.json"); }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF6F1E7);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        // Android 15 以降は画面の端まで描画されるので、ステータスバー等の分だけ内側に寄せる
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/userdata/", this::serveUserData)
                .build();

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setTextZoom(100);
        ws.setMediaPlaybackRequiresUserGesture(true);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                // 外部リンク（地図の出典表示など）はブラウザで開く
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignore) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                flushShared();
            }
        });
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        handleIncoming(getIntent());
        web.loadUrl(START_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIncoming(intent);
        flushShared();
    }

    /** 他のアプリから「共有」や「開く」で渡されたファイル */
    private void handleIncoming(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) pendingShared.add(u);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            pendingShared.add(intent.getData());
        }
    }

    private void flushShared() {
        if (!pageReady || pendingShared.isEmpty()) return;
        List<Uri> uris = new ArrayList<>(pendingShared);
        pendingShared.clear();
        startImport(uris);
    }

    private WebResourceResponse serveUserData(@NonNull String path) {
        File f;
        if (path.startsWith("locations.json")) f = dataFile();
        else return null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        try {
            if (!f.exists()) {
                return new WebResourceResponse("application/json", "utf-8", 404, "Not Found", headers,
                        new java.io.ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8)));
            }
            return new WebResourceResponse("application/json", "utf-8", 200, "OK", headers, new FileInputStream(f));
        } catch (IOException e) {
            return null;
        }
    }

    // --------------------------------------------------------------- JavaScript から呼ぶ機能

    private class Bridge {
        @JavascriptInterface
        public void pickImport() {
            main.post(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(i, REQ_IMPORT);
                } catch (ActivityNotFoundException e) {
                    toast("ファイルを選ぶ画面を開けませんでした");
                }
            });
        }

        @JavascriptInterface
        public String getUser() {
            File f = userFile();
            if (!f.exists()) return "{}";
            try { return readText(f); } catch (IOException e) { return "{}"; }
        }

        @JavascriptInterface
        public boolean saveUser(String json) {
            try {
                writeTextAtomic(userFile(), json);
                return true;
            } catch (IOException e) {
                return false;
            }
        }

        @JavascriptInterface
        public void exportBackup() {
            main.post(() -> {
                String date = new SimpleDateFormat("yyyyMMdd", Locale.JAPAN).format(new Date());
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/json");
                i.putExtra(Intent.EXTRA_TITLE, "ashiato-backup-" + date + ".json");
                try {
                    startActivityForResult(i, REQ_BACKUP);
                } catch (ActivityNotFoundException e) {
                    toast("保存先を選ぶ画面を開けませんでした");
                }
            });
        }

        @JavascriptInterface
        public void clearAll() {
            //noinspection ResultOfMethodCallIgnored
            dataFile().delete();
            //noinspection ResultOfMethodCallIgnored
            userFile().delete();
        }

        @JavascriptInterface
        public void openMap(double lat, double lng, String label) {
            main.post(() -> {
                String q = lat + "," + lng;
                if (label != null && !label.isEmpty()) q += "(" + label.replace("(", " ").replace(")", " ") + ")";
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("geo:" + lat + "," + lng + "?q=" + Uri.encode(q)));
                try {
                    startActivity(i);
                } catch (ActivityNotFoundException e) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW,
                                Uri.parse("https://www.google.com/maps/search/?api=1&query=" + lat + "," + lng)));
                    } catch (ActivityNotFoundException e2) {
                        toast("地図アプリが見つかりませんでした");
                    }
                }
            });
        }

        @JavascriptInterface
        public void openUrl(String url) {
            main.post(() -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                catch (ActivityNotFoundException ignore) { }
            });
        }

        @JavascriptInterface
        public void exitApp() {
            main.post(MainActivity.this::finish);
        }

        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null) {
            if (requestCode == REQ_IMPORT) js("window.onImportCancel && onImportCancel()");
            return;
        }
        if (requestCode == REQ_IMPORT) {
            List<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            startImport(uris);
        } else if (requestCode == REQ_BACKUP && data.getData() != null) {
            writeBackup(data.getData());
        }
    }

    // --------------------------------------------------------------- 読み込み

    private void startImport(List<Uri> uris) {
        if (uris.isEmpty()) return;
        if (busy) { toast("読み込み中です。終わるまでお待ちください"); return; }
        busy = true;
        js("window.onImportProgress && onImportProgress(" + JSONObject.quote("ファイルを開いています…") + ")");
        worker.execute(() -> {
            try {
                LocationImporter imp = new LocationImporter(msg ->
                        js("window.onImportProgress && onImportProgress(" + JSONObject.quote(msg) + ")"));
                List<String> names = new ArrayList<>();
                for (Uri u : uris) {
                    String name = displayName(u);
                    names.add(name);
                    try (InputStream in = getContentResolver().openInputStream(u)) {
                        if (in == null) continue;
                        imp.read(in, name);
                    }
                }
                long added = imp.newItems();
                if (imp.filesRead == 0 || (added == 0 && imp.backupUser == null && imp.fav.isEmpty())) {
                    js("window.onImportError && onImportError(" + JSONObject.quote(
                            "位置履歴のデータが見つかりませんでした。\nGoogleマップのタイムラインから書き出したファイル（Timeline.json など）を選んでください。") + ")");
                    return;
                }
                js("window.onImportProgress && onImportProgress(" + JSONObject.quote("これまでの記録と合わせています…") + ")");
                File f = dataFile();
                if (f.exists()) {
                    try (InputStream in = new FileInputStream(f)) { imp.loadExisting(in); }
                }
                File tmp = new File(getFilesDir(), "locations.json.tmp");
                int[] counts;
                try (BufferedWriter w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8), 1 << 16)) {
                    counts = imp.writeMerged(w);
                }
                if (!tmp.renameTo(f)) throw new IOException("保存に失敗しました");

                JSONObject res = new JSONObject();
                res.put("files", imp.filesRead);
                res.put("added", added);
                res.put("visits", counts[0]);
                res.put("acts", counts[1]);
                res.put("pts", counts[2]);
                if (imp.backupUser != null) res.put("user", imp.backupUser);
                js("window.onImportDone && onImportDone(" + res + ")");
            } catch (OutOfMemoryError e) {
                js("window.onImportError && onImportError(" + JSONObject.quote(
                        "ファイルが大きすぎて読み込めませんでした。月ごとのファイルに分けて読み込んでみてください。") + ")");
            } catch (Exception e) {
                js("window.onImportError && onImportError(" + JSONObject.quote(
                        "読み込みに失敗しました: " + e.getMessage()) + ")");
            } finally {
                busy = false;
            }
        });
    }

    private void writeBackup(Uri dest) {
        worker.execute(() -> {
            try (OutputStream out = getContentResolver().openOutputStream(dest, "wt")) {
                if (out == null) throw new IOException("保存先を開けませんでした");
                String user = userFile().exists() ? readText(userFile()) : "{}";
                out.write(("{\"ashiatoBackup\":1,\"user\":" + user).getBytes(StandardCharsets.UTF_8));
                File f = dataFile();
                if (f.exists()) {
                    try (InputStream in = new FileInputStream(f)) {
                        // 保存データは "{" で始まるので、それを "," に置き換えて続ける
                        byte[] buf = new byte[1 << 16];
                        int n;
                        boolean first = true;
                        while ((n = in.read(buf)) > 0) {
                            int off = 0;
                            if (first) {
                                while (off < n && buf[off] != '{') off++;
                                out.write(',');
                                off++;
                                first = false;
                            }
                            out.write(buf, off, n - off);
                        }
                    }
                } else {
                    out.write('}');
                }
                js("window.onBackupDone && onBackupDone(true)");
            } catch (Exception e) {
                js("window.onBackupDone && onBackupDone(false)");
            }
        });
    }

    // --------------------------------------------------------------- 小道具

    private String displayName(Uri u) {
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignore) { }
        String p = u.getLastPathSegment();
        return p == null ? "" : p;
    }

    private void js(String code) {
        main.post(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    private void toast(String msg) {
        main.post(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
    }

    private static String readText(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toString("UTF-8");
        }
    }

    private void writeTextAtomic(File f, String text) throws IOException {
        File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
        try (OutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(f)) throw new IOException("rename failed");
    }

    @Override
    public void onBackPressed() {
        // 画面内で戻れるときはアプリ内で戻る（詳細画面→一覧など）
        web.evaluateJavascript("window.handleBack ? String(window.handleBack()) : 'false'", value -> {
            if (!"\"true\"".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onDestroy() {
        worker.shutdown();
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
