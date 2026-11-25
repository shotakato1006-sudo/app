package jp.aivtuber.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

/**
 * 指定座標（x, z）へ歩いて近づく。経路探索はせず、目標を向いて前進し、段差では跳ぶ。
 * args: x, z, tolerance（既定 1.2）, timeout_ms（既定 20000, 最大 60000）, sprint
 */
public final class MoveToAction extends AbstractAction {
    private final JsonObject args;
    private double tx, tz, tolerance;
    private int timeoutTicks;
    private boolean sprint;
    private Vec3 lastProgressPos;
    private int lastProgressTick;
    private double finalDistance;

    public MoveToAction(JsonObject args) {
        this.args = args;
    }

    @Override
    public String name() {
        return "move_to";
    }

    @Override
    protected String onStart(Minecraft mc, LocalPlayer p) {
        if (!Json.has(args, "x") || !Json.has(args, "z")) return "missing_target";
        tx = Json.num(args, "x", 0);
        tz = Json.num(args, "z", 0);
        tolerance = Mth.clamp(Json.num(args, "tolerance", 1.2), 0.5, 10);
        timeoutTicks = (int) (Mth.clamp(Json.num(args, "timeout_ms", 20000), 1000, 60000) / 50);
        sprint = Json.bool(args, "sprint", false);
        if (Math.hypot(tx - p.getX(), tz - p.getZ()) > 128) return "too_far";
        lastProgressPos = p.position();
        lastProgressTick = 0;
        return null;
    }

    @Override
    protected Status onTick(Minecraft mc, LocalPlayer p) {
        double dist = Math.hypot(tx - p.getX(), tz - p.getZ());
        finalDistance = dist;
        if (dist <= tolerance) {
            Inputs.releaseAll(mc);
            return Status.SUCCEEDED;
        }
        if (ticks > timeoutTicks) {
            Inputs.releaseAll(mc);
            return fail("timeout");
        }
        // 進んでいなければ詰まっているとみなす（2秒）
        if (p.position().distanceTo(lastProgressPos) > 0.4) {
            lastProgressPos = p.position();
            lastProgressTick = ticks;
        } else if (ticks - lastProgressTick > 40) {
            Inputs.releaseAll(mc);
            return fail("stuck");
        }

        float desiredYaw = Rot.yawTo(p.position(), new Vec3(tx, p.getY(), tz));
        if (Danger.lavaAt(p, desiredYaw)) {
            Inputs.releaseAll(mc);
            return fail("danger_lava");
        }
        // 歩きながら自然に向きを変える。視線は少しだけ下向きの水平に戻す。
        Rot.approach(p, desiredYaw, Mth.clamp(p.getXRot(), -10f, 15f), 12f);
        float yawErr = Math.abs(Mth.wrapDegrees(desiredYaw - p.getYRot()));
        boolean forward = yawErr < 60f;
        boolean jump = (p.horizontalCollision && p.onGround()) || p.isInWater();
        Inputs.set(mc, forward, false, false, false, jump, false, sprint && forward && dist > 4);
        return Status.RUNNING;
    }

    @Override
    public JsonObject observed(Minecraft mc, LocalPlayer p) {
        JsonObject o = super.observed(mc, p);
        o.addProperty("target_x", Json.round(tx));
        o.addProperty("target_z", Json.round(tz));
        o.addProperty("remaining_distance", Json.round(finalDistance));
        return o;
    }
}
