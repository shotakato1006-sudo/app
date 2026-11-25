package jp.aivtuber.bridge.action;

import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Options;

/** キー入力の押下・解除。人が操作するのと同じキー割り当てを押すことで、配信画面のプレイヤーを動かす。 */
public final class Inputs {
    private Inputs() {}

    public static void set(Minecraft mc, boolean forward, boolean back, boolean left, boolean right,
                           boolean jump, boolean sneak, boolean sprint) {
        Options o = mc.options;
        o.keyUp.setDown(forward);
        o.keyDown.setDown(back);
        o.keyLeft.setDown(left);
        o.keyRight.setDown(right);
        o.keyJump.setDown(jump);
        o.keyShift.setDown(sneak);
        o.keySprint.setDown(sprint);
    }

    /** 移動系の入力をすべて離す。 */
    public static void releaseAll(Minecraft mc) {
        Options o = mc.options;
        for (KeyMapping k : new KeyMapping[]{o.keyUp, o.keyDown, o.keyLeft, o.keyRight, o.keyJump,
                o.keyShift, o.keySprint, o.keyAttack, o.keyUse}) {
            k.setDown(false);
        }
        if (mc.player != null) {
            mc.player.setSprinting(false);
        }
    }
}
