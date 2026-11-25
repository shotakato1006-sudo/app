package jp.aivtuber.bridge.action;

import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.FluidTags;
import net.minecraft.util.Mth;
import net.minecraft.world.level.Level;

/** 進行方向の足元に溶岩があるかを調べる簡易チェック。 */
public final class Danger {
    private Danger() {}

    public static boolean lavaAhead(LocalPlayer p, String direction) {
        float yaw = p.getYRot();
        switch (direction) {
            case "back" -> yaw += 180f;
            case "left" -> yaw -= 90f;
            case "right" -> yaw += 90f;
            default -> {}
        }
        return lavaAt(p, yaw);
    }

    public static boolean lavaAt(LocalPlayer p, float yaw) {
        double rad = yaw * Mth.DEG_TO_RAD;
        double dx = -Math.sin(rad), dz = Math.cos(rad);
        Level level = p.level();
        for (double dist = 0.6; dist <= 1.6; dist += 0.5) {
            BlockPos base = BlockPos.containing(p.getX() + dx * dist, p.getY(), p.getZ() + dz * dist);
            for (int dy = -2; dy <= 0; dy++) {
                if (level.getFluidState(base.offset(0, dy, 0)).is(FluidTags.LAVA)) return true;
            }
        }
        return false;
    }
}
