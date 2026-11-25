package jp.aivtuber.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;

/** 1つの操作。クライアントスレッドの tick から呼ばれる。 */
public interface BridgeAction {
    enum Status { RUNNING, SUCCEEDED, FAILED }

    String name();

    /** 開始する。開始できないときは失敗理由を返す。開始できたら null。 */
    String start(Minecraft mc, LocalPlayer player);

    /** 毎tick呼ばれる。 */
    Status tick(Minecraft mc, LocalPlayer player);

    /** FAILED のときの理由（機械向けの短いコード）。 */
    String failureReason();

    /** 押下中の入力を必ず解除する。終了・中断・切断時に呼ばれる。 */
    void release(Minecraft mc);

    /** 実際に観測できた変化。 */
    JsonObject observed(Minecraft mc, LocalPlayer player);
}
