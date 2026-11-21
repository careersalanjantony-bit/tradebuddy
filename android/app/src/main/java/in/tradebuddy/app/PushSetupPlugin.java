package in.tradebuddy.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Milestone 4: tells the app whether this APK was built with Firebase (a google-services.json in
 * android/app). Without it, Firebase is not set up in the app and asking it for a push token would
 * stop the app — so the app checks here first and explains instead.
 *
 * The Google Services Gradle plugin turns google-services.json into the "google_app_id" string
 * resource; Firebase starts only when that resource exists.
 */
@CapacitorPlugin(name = "PushSetup")
public class PushSetupPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        boolean configured = false;
        try {
            int id = getContext().getResources().getIdentifier("google_app_id", "string", getContext().getPackageName());
            configured = id != 0 && !getContext().getString(id).isEmpty();
        } catch (Exception ignored) {
            // treat as not configured
        }
        JSObject ret = new JSObject();
        ret.put("configured", configured);
        call.resolve(ret);
    }
}
