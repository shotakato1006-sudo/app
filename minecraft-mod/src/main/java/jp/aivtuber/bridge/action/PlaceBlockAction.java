package jp.aivtuber.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * クリエイティブで、指定座標にブロックを1つ置く。手に指定ブロックを持ち、隣接ブロックの面を見て右クリックする。
 * args: x, y, z, block（例 "minecraft:oak_planks"）
 */
public final class PlaceBlockAction extends AbstractAction {
    private static final double REACH = 4.5;
    private final JsonObject args;
    private BlockPos target;
    private Block block;
    private BlockPos clickPos;
    private Direction clickFace;
    private Vec3 hitVec;
    private int phase; // 0=視点合わせ 1=設置 2=確認
    private int phaseTick;
    private String placedId;

    public PlaceBlockAction(JsonObject args) {
        this.args = args;
    }

    @Override
    public String name() {
        return "place_block";
    }

    @Override
    protected String onStart(Minecraft mc, LocalPlayer p) {
        if (!Json.has(args, "x") || !Json.has(args, "y") || !Json.has(args, "z")) return "missing_target";
        if (!p.getAbilities().instabuild) return "not_creative";
        target = BlockPos.containing(Json.num(args, "x", 0), Json.num(args, "y", 0), Json.num(args, "z", 0));
        String id = Json.str(args, "block", "minecraft:oak_planks");
        Identifier key = Identifier.tryParse(id);
        if (key == null) return "unknown_block";
        Item item = BuiltInRegistries.ITEM.getValue(key);
        if (!(item instanceof BlockItem blockItem)) return "unknown_block";
        block = blockItem.getBlock();

        BlockState current = p.level().getBlockState(target);
        if (!current.canBeReplaced()) return "occupied";
        if (p.getBoundingBox().intersects(new net.minecraft.world.phys.AABB(target))) return "player_in_the_way";
        if (p.getEyePosition().distanceTo(Vec3.atCenterOf(target)) > REACH) return "too_far";

        // 置く面を探す（下の地面を優先）
        Direction[] order = {Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP};
        for (Direction d : order) {
            BlockPos n = target.relative(d);
            if (!p.level().getBlockState(n).canBeReplaced()) {
                clickPos = n;
                clickFace = d.getOpposite();
                hitVec = Vec3.atCenterOf(n).add(Vec3.atLowerCornerOf(clickFace.getUnitVec3i()).scale(0.5));
                break;
            }
        }
        if (clickPos == null) return "no_support";

        // 手に持たせる（クリエイティブのホットバー操作）
        ItemStack stack = new ItemStack(item);
        int slot = p.getInventory().getSelectedSlot();
        p.getInventory().setItem(slot, stack);
        mc.gameMode.handleCreativeModeItemAdd(stack, 36 + slot);
        phase = 0;
        phaseTick = 0;
        return null;
    }

    @Override
    protected Status onTick(Minecraft mc, LocalPlayer p) {
        phaseTick++;
        switch (phase) {
            case 0 -> {
                float yaw = Rot.yawTo(p.getEyePosition(), hitVec);
                float pitch = Rot.pitchTo(p.getEyePosition(), hitVec);
                if (Rot.approach(p, yaw, pitch, 15f) || phaseTick > 20) {
                    phase = 1;
                    phaseTick = 0;
                }
            }
            case 1 -> {
                BlockHitResult hit = new BlockHitResult(hitVec, clickFace, clickPos, false);
                InteractionResult r = mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, hit);
                if (r.consumesAction()) p.swing(InteractionHand.MAIN_HAND);
                phase = 2;
                phaseTick = 0;
            }
            default -> {
                BlockState now = p.level().getBlockState(target);
                placedId = BuiltInRegistries.BLOCK.getKey(now.getBlock()).toString();
                if (now.is(block)) return Status.SUCCEEDED;
                if (phaseTick > 10) return fail("not_placed");
            }
        }
        return Status.RUNNING;
    }

    @Override
    public JsonObject observed(Minecraft mc, LocalPlayer p) {
        JsonObject o = super.observed(mc, p);
        if (target != null) {
            o.add("target", Json.pos(target));
            o.addProperty("block_at_target", BuiltInRegistries.BLOCK.getKey(p.level().getBlockState(target).getBlock()).toString());
        }
        return o;
    }
}
