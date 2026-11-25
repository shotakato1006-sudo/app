package jp.aivtuber.bridge.action;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;

/** その場で1回跳ぶ。 */
public final class JumpAction extends AbstractAction {
    private double maxY;

    @Override
    public String name() {
        return "jump";
    }

    @Override
    protected String onStart(Minecraft mc, LocalPlayer p) {
        maxY = p.getY();
        return null;
    }

    @Override
    protected Status onTick(Minecraft mc, LocalPlayer p) {
        maxY = Math.max(maxY, p.getY());
        boolean rose = maxY - startPos.y > 0.3;
        // 地面に着くまで（最大0.5秒）跳ぶキーを押し続け、上がり始めたら離す
        Inputs.set(mc, false, false, false, false, !rose && ticks <= 10, false, false);
        if (rose && p.onGround()) {
            Inputs.releaseAll(mc);
            return Status.SUCCEEDED;
        }
        if (!rose && ticks > 12) {
            Inputs.releaseAll(mc);
            return fail("did_not_jump");
        }
        if (ticks > 40) {
            Inputs.releaseAll(mc);
            return Status.SUCCEEDED;
        }
        return Status.RUNNING;
    }
}
