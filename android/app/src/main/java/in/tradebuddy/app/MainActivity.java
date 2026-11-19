package in.tradebuddy.app;

import android.os.Build;
import android.os.Bundle;
import android.view.Display;
import android.view.View;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // app's own plugin: in-app updates from TradeBuddy's GitHub updates branch
        registerPlugin(AppUpdaterPlugin.class);
        // milestone 4: is this build set up for Firebase push (google-services.json)?
        registerPlugin(PushSetupPlugin.class);
        super.onCreate(savedInstanceState);
        preferHighRefreshRate();
    }

    @Override
    public void onResume() {
        super.onResume();
        preferHighRefreshRate();
    }

    /**
     * App v1.7: ask for the screen's fastest refresh rate (90 / 120 / 144 Hz where the phone has it),
     * at the current resolution. Many phones keep apps at 60 Hz unless the app asks. The phone still
     * decides in the end (battery saver, its own "smoothness" setting).
     */
    private void preferHighRefreshRate() {
        try {
            Display display = Build.VERSION.SDK_INT >= 30 ? getDisplay() : getWindowManager().getDefaultDisplay();
            if (display == null) return;
            Display.Mode current = display.getMode();
            Display.Mode best = current;
            for (Display.Mode m : display.getSupportedModes()) {
                boolean sameSize = m.getPhysicalWidth() == current.getPhysicalWidth() && m.getPhysicalHeight() == current.getPhysicalHeight();
                if (sameSize && m.getRefreshRate() > best.getRefreshRate() + 0.5f) best = m;
            }
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            if (lp.preferredDisplayModeId != best.getModeId()) {
                lp.preferredDisplayModeId = best.getModeId();
                getWindow().setAttributes(lp);
            }
            // Android 15+: also tell the system the web view wants a high frame rate while it animates
            if (Build.VERSION.SDK_INT >= 35 && getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
            }
        } catch (Throwable ignored) {
            // older or unusual phones: keep the default
        }
    }
}
