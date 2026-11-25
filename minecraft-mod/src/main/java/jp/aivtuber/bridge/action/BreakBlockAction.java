package jp.aivtuber.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.phys.Vec3;

/** クリエイティブで、指定座標のブロックを1つ壊す。args: x, y, z */
public final class BreakBlockAction extends AbstractAction {
    private static final double REACH = 4.5;
    private final JsonObject args;
    private BlockPos target;
    private String brokenId;
    private int phase;
    private int phaseTick;

    public BreakBlockAction(JsonObject args) {
        this.args = args;
    }

    @Override
    public String name() {
        return "break_block";
    }

    @Override
    protected String onStart(Minecraft mc, LocalPlayer p) {
        if (!Json.has(args, "x") || !Json.has(args, "y") || !Json.has(args, "z")) return "missing_target";
        if (!p.getAbilities().instabuild) return "not_creative";
        target = BlockPos.containing(Json.num(args, "x", 0), Json.num(args, "y", 0), Json.num(args, "z", 0));
        if (p.level().getBlockState(target).isAir()) return "already_empty";
        if (p.getEyePosition().distanceTo(Vec3.atCenterOf(target)) > REACH) return "too_far";
        brokenId = BuiltInRegistries.BLOCK.getKey(p.level().getBlockState(target).getBlock()).toString();
        return null;
    }

    @Override
    protected Status onTick(Minecraft mc, LocalPlayer p) {
        phaseTick++;
        Vec3 center = Vec3.atCenterOf(target);
        switch (phase) {
            case 0 -> {
                if (Rot.approach(p, Rot.yawTo(p.getEyePosition(), center), Rot.pitchTo(p.getEyePosition(), center), 15f)
                        || phaseTick > 20) {
                    phase = 1;
                    phaseTick = 0;
                }
            }
            case 1 -> {
                Direction face = Direction.getApproximateNearest(p.getEyePosition().subtract(center));
                mc.gameMode.startDestroyBlock(target, face);
                p.swing(InteractionHand.MAIN_HAND);
                phase = 2;
                phaseTick = 0;
            }
            default -> {
                if (p.level().getBlockState(target).isAir()) return Status.SUCCEEDED;
                if (phaseTick > 10) return fail("not_broken");
            }
        }
        return Status.RUNNING;
    }

    @Override
    public JsonObject observed(Minecraft mc, LocalPlayer p) {
        JsonObject o = super.observed(mc, p);
        if (target != null) {
            o.add("target", Json.pos(target));
            o.addProperty("block_before", brokenId);
            o.addProperty("block_at_target", BuiltInRegistries.BLOCK.getKey(p.level().getBlockState(target).getBlock()).toString());
        }
        return o;
    }
}
