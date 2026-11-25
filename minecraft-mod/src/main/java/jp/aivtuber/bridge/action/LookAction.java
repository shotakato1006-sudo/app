package jp.aivtuber.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

/**
 * 視点変更。引数は次のいずれか:
 *  - yaw / pitch（絶対値。片方だけでも可）
 *  - delta_yaw / delta_pitch（今の向きからの差分。右が正）
 *  - x, y, z（その座標を見る）
 * duration_ms で滑らかに回す（既定 600ms）。
 */
public final class LookAction extends AbstractAction {
    private final JsonObject args;
    private float targetYaw, targetPitch, step;

    public LookAction(JsonObject args) {
        this.args = args;
    }

    @Override
    public String name() {
        return "look";
    }

    @Override
    protected String onStart(Minecraft mc, LocalPlayer p) {
        if (Json.has(args, "x") && Json.has(args, "y") && Json.has(args, "z")) {
            Vec3 target = new Vec3(Json.num(args, "x", 0), Json.num(args, "y", 0), Json.num(args, "z", 0));
            targetYaw = Rot.yawTo(p.getEyePosition(), target);
            targetPitch = Rot.pitchTo(p.getEyePosition(), target);
        } else {
            targetYaw = (float) Json.num(args, "yaw", p.getYRot());
            targetPitch = (float) Json.num(args, "pitch", p.getXRot());
            targetYaw += (float) Json.num(args, "delta_yaw", 0);
            targetPitch += (float) Json.num(args, "delta_pitch", 0);
        }
        targetPitch = Mth.clamp(targetPitch, -90f, 90f);
        double durationMs = Mth.clamp(Json.num(args, "duration_ms", 600), 50, 10000);
        int totalTicks = Math.max(1, (int) Math.round(durationMs / 50.0));
        float dy = Math.abs(Mth.wrapDegrees(targetYaw - p.getYRot()));
        float dp = Math.abs(targetPitch - p.getXRot());
        step = Math.max(0.5f, Math.max(dy, dp) / totalTicks);
        return null;
    }

    @Override
    protected Status onTick(Minecraft mc, LocalPlayer p) {
        if (Rot.approach(p, targetYaw, targetPitch, step)) return Status.SUCCEEDED;
        if (ticks > 400) return fail("timeout");
        return Status.RUNNING;
    }

    @Override
    public JsonObject observed(Minecraft mc, LocalPlayer p) {
        JsonObject o = super.observed(mc, p);
        o.addProperty("target_yaw", Json.round(Mth.wrapDegrees(targetYaw)));
        o.addProperty("target_pitch", Json.round(targetPitch));
        return o;
    }
}
