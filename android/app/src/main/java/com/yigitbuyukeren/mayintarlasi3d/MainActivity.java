package com.yigitbuyukeren.mayintarlasi3d;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/**
 * Tek sayfalık oyunu yerel assetlerden çevrimdışı çalıştıran minimal kabuk.
 *
 * <p>Web içeriği yalnız {@code https://appassets.androidplatform.net/assets/} origin'inde
 * sunulur. Ağ izni yoktur; harici navigasyon ve kaynak istekleri engellenir. JavaScript köprüsü
 * yoktur; yaşam döngüsü ve geri tuşu yalnız {@code evaluateJavascript} ile yönetilir.</p>
 */
public final class MainActivity extends Activity {

    private static final String TAG = "MT3D";
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = "https://" + APP_HOST + "/assets/index.html";

    private static final String JS_PAUSE =
            "(function(){try{if(window.mt3dApp&&typeof window.mt3dApp.pause==='function')"
                    + "window.mt3dApp.pause();}catch(e){}})()";
    private static final String JS_RESUME =
            "(function(){try{if(window.mt3dApp&&typeof window.mt3dApp.resume==='function')"
                    + "window.mt3dApp.resume();}catch(e){}})()";
    private static final String JS_BACK =
            "(function(){try{var a=window.mt3dApp;"
                    + "var handled=!!(a&&typeof a.back==='function'&&a.back());"
                    + "return handled===true;}catch(e){return false;}})()";

    private FrameLayout root;
    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private View errorView;
    private TextView errorMessage;
    private AlertDialog exitDialog;
    private boolean mainFrameFailed;
    private boolean backCheckPending;
    private boolean activityPaused;
    private Object backCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Hata ayıklama yalnız debug derlemesinde açılır; release'te WebView uzaktan incelenemez.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        configureWindow();
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.sky));
        setContentView(root);
        applySystemBarInsets();

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .setHttpAllowed(false)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        createErrorView();
        loadApp();
        registerBackCallback();
    }

    private void configureWindow() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
        }
    }

    private void applySystemBarInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return;
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        root.requestApplyInsets();
    }

    private void registerBackCallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        backCallback = Api33Back.register(this, this::handleBackRequested);
    }

    @android.annotation.TargetApi(33)
    private static final class Api33Back {
        static Object register(Activity activity, Runnable action) {
            OnBackInvokedCallback callback = action::run;
            activity.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            return callback;
        }

        static void unregister(Activity activity, Object callback) {
            activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(
                    (OnBackInvokedCallback) callback);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        if (webView != null || isFinishing() || isDestroyed()) {
            return;
        }
        WebView view = new WebView(this);
        view.setBackgroundColor(getColor(R.color.sky));

        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setGeolocationEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setDefaultTextEncodingName("utf-8");
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        view.setWebViewClient(new LocalWebViewClient());
        view.setWebChromeClient(new LocalChromeClient());
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);

        webView = view;
        root.addView(view, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void loadApp() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        mainFrameFailed = false;
        hideError();
        if (webView == null) {
            createWebView();
        }
        if (webView != null) {
            webView.loadUrl(APP_URL);
        }
    }

    private void releaseWebView() {
        WebView view = webView;
        webView = null;
        backCheckPending = false;
        if (view == null) {
            return;
        }
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) {
            parent.removeView(view);
        }
        view.stopLoading();
        view.setWebChromeClient(null);
        view.setWebViewClient(null);
        view.destroy();
    }

    private void handleBackRequested() {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        if (exitDialog != null && exitDialog.isShowing()) {
            return;
        }
        if (backCheckPending) {
            return;
        }
        WebView view = webView;
        if (view == null) {
            showExitDialog();
            return;
        }
        backCheckPending = true;
        view.evaluateJavascript(JS_BACK, value -> {
            backCheckPending = false;
            if (isFinishing() || isDestroyed()) {
                return;
            }
            // Sözleşme: yalnız JSON false sonucunda native çıkış onayı gösterilir.
            if ("false".equals(value)) {
                showExitDialog();
            }
        });
    }

    private void showExitDialog() {
        if (isFinishing() || isDestroyed()
                || (exitDialog != null && exitDialog.isShowing())) {
            return;
        }
        exitDialog = new AlertDialog.Builder(this)
                .setTitle(R.string.exit_title)
                .setMessage(R.string.exit_message)
                .setPositiveButton(R.string.exit_confirm, (dialog, which) -> saveAndFinish())
                .setNegativeButton(R.string.cancel, null)
                .create();
        exitDialog.setOnDismissListener(dialog -> exitDialog = null);
        exitDialog.show();
    }

    private void saveAndFinish() {
        WebView view = webView;
        if (view == null) {
            finish();
            return;
        }
        // Normal çıkışta kayıt isteğini WebView yok edilmeden tamamla.
        view.evaluateJavascript(JS_PAUSE, value -> {
            if (!isFinishing() && !isDestroyed()) {
                finish();
            }
        });
    }

    private void checkGameReady(WebView view) {
        view.postDelayed(() -> {
            if (activityPaused || webView != view || mainFrameFailed || isDestroyed()) {
                return;
            }
            view.evaluateJavascript("!!window.mt3dApp", value -> {
                if ("false".equals(value) && webView == view && !activityPaused) {
                    mainFrameFailed = true;
                    showError("Oyun başlatılamadı. Android System WebView'i güncelleyip yeniden deneyin.");
                }
            });
        }, 8000);
    }

    private void createErrorView() {
        FrameLayout overlay = new FrameLayout(this);
        overlay.setBackgroundColor(getColor(R.color.error_scrim));
        overlay.setClickable(true);
        overlay.setFocusable(true);
        overlay.setVisibility(View.GONE);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(24), dp(24), dp(24), dp(20));
        GradientDrawable cardBackground = new GradientDrawable();
        cardBackground.setColor(getColor(R.color.panel));
        cardBackground.setCornerRadius(dp(20));
        card.setBackground(cardBackground);

        TextView title = new TextView(this);
        title.setText(R.string.error_title);
        title.setTextColor(getColor(R.color.text));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        card.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        errorMessage = new TextView(this);
        errorMessage.setTextColor(getColor(R.color.muted));
        errorMessage.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        errorMessage.setLineSpacing(0f, 1.15f);
        LinearLayout.LayoutParams messageParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        messageParams.topMargin = dp(12);
        card.addView(errorMessage, messageParams);

        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setTextColor(getColor(R.color.nav));
        retry.setAllCaps(false);
        GradientDrawable buttonBackground = new GradientDrawable();
        buttonBackground.setColor(getColor(R.color.accent));
        buttonBackground.setCornerRadius(dp(12));
        retry.setBackground(buttonBackground);
        retry.setMinHeight(dp(48));
        retry.setOnClickListener(view -> loadApp());
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        retryParams.topMargin = dp(18);
        retryParams.gravity = Gravity.END;
        card.addView(retry, retryParams);

        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardParams.gravity = Gravity.CENTER;
        cardParams.setMargins(dp(24), dp(24), dp(24), dp(24));
        overlay.addView(card, cardParams);

        errorView = overlay;
        root.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void showError(String detail) {
        if (errorView == null || isFinishing() || isDestroyed()) {
            return;
        }
        String suffix = detail == null || detail.trim().isEmpty() ? "" : "\n\n" + detail.trim();
        errorMessage.setText(getString(
                R.string.error_full, getString(R.string.error_body), suffix));
        errorView.setVisibility(View.VISIBLE);
        errorView.bringToFront();
    }

    private void hideError() {
        if (errorView != null) {
            errorView.setVisibility(View.GONE);
        }
    }

    private boolean isAppAsset(Uri uri) {
        if (uri == null
                || !"https".equalsIgnoreCase(uri.getScheme())
                || !APP_HOST.equalsIgnoreCase(uri.getHost())) {
            return false;
        }
        int port = uri.getPort();
        if (port != -1 && port != 443) {
            return false;
        }
        String path = uri.getPath();
        if (path == null || !path.startsWith("/assets/")) {
            return false;
        }
        return !path.contains("/../") && !path.endsWith("/..");
    }

    private static WebResourceResponse emptyResponse(int status, String reason) {
        return new WebResourceResponse(
                "text/plain",
                StandardCharsets.UTF_8.name(),
                status,
                reason,
                Collections.emptyMap(),
                new ByteArrayInputStream(new byte[0]));
    }

    @Override
    @SuppressLint("GestureBackNavigation")
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBackRequested();
    }

    @Override
    protected void onPause() {
        activityPaused = true;
        WebView view = webView;
        if (view != null) {
            // Önce JavaScript kaydı tamamlasın; evaluateJavascript asenkrondur.
            view.evaluateJavascript(JS_PAUSE, value -> {
                if (activityPaused && webView == view && !isDestroyed()) {
                    view.onPause();
                    view.pauseTimers();
                }
            });
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityPaused = false;
        WebView view = webView;
        if (view != null) {
            view.resumeTimers();
            view.onResume();
            // resume() sözleşmesi oyunu kendiliğinden başlatmaz; yalnız zamanlayıcı/ses durumunu tazeler.
            view.evaluateJavascript(JS_RESUME, null);
            checkGameReady(view);
        }
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backCallback != null) {
            Api33Back.unregister(this, backCallback);
            backCallback = null;
        }
        if (exitDialog != null) {
            exitDialog.dismiss();
            exitDialog = null;
        }
        releaseWebView();
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class LocalWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if ("data".equalsIgnoreCase(scheme)
                    || "blob".equalsIgnoreCase(scheme)
                    || "about".equalsIgnoreCase(scheme)) {
                return null;
            }
            if (isAppAsset(uri)) {
                WebResourceResponse response = assetLoader.shouldInterceptRequest(uri);
                return response != null ? response : emptyResponse(404, "Not Found");
            }
            return emptyResponse(403, "Forbidden");
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !isAppAsset(request.getUrl());
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!mainFrameFailed && isAppAsset(Uri.parse(url))) {
                hideError();
                checkGameReady(view);
            }
        }

        @Override
        public void onReceivedError(
                WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() || isAppAsset(request.getUrl())) {
                mainFrameFailed = true;
                showError(error.getDescription() == null ? null : error.getDescription().toString());
            }
        }

        @Override
        public void onReceivedHttpError(
                WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            if ((request.isForMainFrame() || isAppAsset(request.getUrl()))
                    && errorResponse.getStatusCode() >= 400) {
                mainFrameFailed = true;
                showError("HTTP " + errorResponse.getStatusCode());
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            releaseWebView();
            mainFrameFailed = true;
            showError(getString(R.string.error_renderer));
            return true;
        }
    }

    private final class LocalChromeClient extends WebChromeClient {

        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            if (BuildConfig.DEBUG) {
                Log.d(TAG, message.message() + " @" + message.lineNumber());
            }
            return true;
        }

        @Override
        public boolean onJsAlert(
                WebView view, String url, String message, JsResult result) {
            if (isFinishing() || isDestroyed()) {
                result.cancel();
                return true;
            }
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(R.string.js_alert_title)
                    .setMessage(message)
                    .setPositiveButton(R.string.ok, (dialog, which) -> result.confirm())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(
                WebView view, String url, String message, JsResult result) {
            if (isFinishing() || isDestroyed()) {
                result.cancel();
                return true;
            }
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(R.string.js_alert_title)
                    .setMessage(message)
                    .setPositiveButton(R.string.ok, (dialog, which) -> result.confirm())
                    .setNegativeButton(R.string.cancel, (dialog, which) -> result.cancel())
                    .setOnCancelListener(dialog -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsPrompt(
                WebView view, String url, String message, String defaultValue, JsPromptResult result) {
            result.cancel();
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }
    }
}
