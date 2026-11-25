package jp.aivtuber.bridge.action;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.util.Mth;

/** 何もせず眺める。args: duration_ms（既定 2000, 最大 30000） */
public final class WaitAction extends AbstractAction {
    private final int durationTicks;

    public WaitAction(com.google.gson.JsonObject args) {
        durationTicks = Math.max(1, (int) (Mth.clamp(Json.num(args, "duration_ms", 2000), 50, 30000) / 50));
    }

    @Override
    public String name() {
        return "wait";
    }

    @Override
    protected String onStart(Minecraft mc, LocalPlayer p) {
        Inputs.releaseAll(mc);
        return null;
    }

    @Override
    protected Status onTick(Minecraft mc, LocalPlayer p) {
        return ticks >= durationTicks ? Status.SUCCEEDED : Status.RUNNING;
    }
}
