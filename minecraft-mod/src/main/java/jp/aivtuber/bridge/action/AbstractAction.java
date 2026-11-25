package jp.aivtuber.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.phys.Vec3;

/** 開始時と終了時の位置・向きを記録し、実際の変化を返す共通部分。 */
public abstract class AbstractAction implements BridgeAction {
    protected Vec3 startPos;
    protected float startYaw, startPitch;
    protected int ticks;
    protected String reason;

    @Override
    public final String start(Minecraft mc, LocalPlayer p) {
        startPos = p.position();
        startYaw = p.getYRot();
        startPitch = p.getXRot();
        ticks = 0;
        return onStart(mc, p);
    }

    protected abstract String onStart(Minecraft mc, LocalPlayer p);

    @Override
    public final Status tick(Minecraft mc, LocalPlayer p) {
        ticks++;
        return onTick(mc, p);
    }

    protected abstract Status onTick(Minecraft mc, LocalPlayer p);

    protected Status fail(String r) {
        reason = r;
        return Status.FAILED;
    }

    @Override
    public String failureReason() {
        return reason;
    }

    @Override
    public void release(Minecraft mc) {
        Inputs.releaseAll(mc);
    }

    @Override
    public JsonObject observed(Minecraft mc, LocalPlayer p) {
        JsonObject o = new JsonObject();
        Vec3 now = p.position();
        o.add("pos_before", Json.vec(startPos));
        o.add("pos_after", Json.vec(now));
        o.addProperty("moved", Json.round(now.distanceTo(startPos)));
        o.addProperty("moved_horizontal", Json.round(Math.hypot(now.x - startPos.x, now.z - startPos.z)));
        o.addProperty("yaw_before", Json.round(startYaw));
        o.addProperty("pitch_before", Json.round(startPitch));
        o.addProperty("yaw_after", Json.round(p.getYRot()));
        o.addProperty("pitch_after", Json.round(p.getXRot()));
        o.addProperty("facing_after", Rot.compass(p.getYRot()));
        o.addProperty("ticks", ticks);
        return o;
    }
}
