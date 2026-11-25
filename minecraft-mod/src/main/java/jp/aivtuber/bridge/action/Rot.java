package jp.aivtuber.bridge.action;

import net.minecraft.client.player.LocalPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

/** 視点の計算。Minecraftのyawは 0=南(+Z), 90=西(-X), 180=北(-Z), -90=東(+X)。pitchは下向きが正。 */
public final class Rot {
    private Rot() {}

    public static float yawTo(Vec3 from, Vec3 to) {
        double dx = to.x - from.x, dz = to.z - from.z;
        return Mth.wrapDegrees((float) (Mth.atan2(dz, dx) * Mth.RAD_TO_DEG) - 90f);
    }

    public static float pitchTo(Vec3 from, Vec3 to) {
        double dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        double h = Math.sqrt(dx * dx + dz * dz);
        return Mth.clamp((float) (-(Mth.atan2(dy, h) * Mth.RAD_TO_DEG)), -90f, 90f);
    }

    /** 目標の向きへ最大 maxStep 度だけ近づける。到達したら true。 */
    public static boolean approach(LocalPlayer p, float targetYaw, float targetPitch, float maxStep) {
        float yaw = p.getYRot();
        float dy = Mth.wrapDegrees(targetYaw - yaw);
        float dp = targetPitch - p.getXRot();
        float stepY = Mth.clamp(dy, -maxStep, maxStep);
        float stepP = Mth.clamp(dp, -maxStep, maxStep);
        float newYaw = yaw + stepY;
        float newPitch = Mth.clamp(p.getXRot() + stepP, -90f, 90f);
        p.setYRot(newYaw);
        p.setXRot(newPitch);
        p.setYHeadRot(newYaw);
        return Math.abs(dy - stepY) < 0.01f && Math.abs(dp - stepP) < 0.01f;
    }

    /** 方位を8方向の日本語で返す。 */
    public static String compass(float yaw) {
        float y = Mth.wrapDegrees(yaw);
        String[] names = {"南", "南西", "西", "北西", "北", "北東", "東", "南東"};
        int idx = Math.floorMod(Math.round(y / 45f), 8);
        return names[idx];
    }

    /** プレイヤーの向きから見た相対方向（前・右前・右…）。 */
    public static String relative(float playerYaw, float targetYaw) {
        float d = Mth.wrapDegrees(targetYaw - playerYaw);
        // yawは時計回りに増える（南→西）。プレイヤーから見て右は +90。
        String[] names = {"前", "右前", "右", "右後ろ", "後ろ", "左後ろ", "左", "左前"};
        int idx = Math.floorMod(Math.round(d / 45f), 8);
        return names[idx];
    }
}
