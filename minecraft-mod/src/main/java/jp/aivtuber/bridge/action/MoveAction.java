package jp.aivtuber.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.util.Mth;

/**
 * 一定時間キーを押して歩く。
 * args: direction = forward|back|left|right（既定 forward）, duration_ms（既定 1000, 最大 10000）,
 *       sprint, jump（押しっぱなし）, sneak
 */
public final class MoveAction extends AbstractAction {
    private final JsonObject args;
    private String direction;
    private int durationTicks;
    private boolean sprint, jump, sneak;

    public MoveAction(JsonObject args) {
        this.args = args;
    }

    @Override
    public String name() {
        return "move";
    }

    @Override
    protected String onStart(Minecraft mc, LocalPlayer p) {
        direction = Json.str(args, "direction", "forward");
        if (!direction.matches("forward|back|left|right")) return "invalid_direction";
        durationTicks = Math.max(1, (int) Math.round(Mth.clamp(Json.num(args, "duration_ms", 1000), 50, 10000) / 50.0));
        sprint = Json.bool(args, "sprint", false);
        jump = Json.bool(args, "jump", false);
        sneak = Json.bool(args, "sneak", false);
        return null;
    }

    @Override
    protected Status onTick(Minecraft mc, LocalPlayer p) {
        if (ticks > durationTicks) {
            Inputs.releaseAll(mc);
            double moved = Math.hypot(p.getX() - startPos.x, p.getZ() - startPos.z);
            return moved >= 0.3 ? Status.SUCCEEDED : fail("no_movement");
        }
        if (Danger.lavaAhead(p, direction)) {
            Inputs.releaseAll(mc);
            return fail("danger_lava");
        }
        Inputs.set(mc, direction.equals("forward"), direction.equals("back"), direction.equals("left"),
                direction.equals("right"), jump, sneak, sprint && direction.equals("forward"));
        return Status.RUNNING;
    }
}
