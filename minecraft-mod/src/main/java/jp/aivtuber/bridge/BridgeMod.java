package jp.aivtuber.bridge;

import com.mojang.blaze3d.platform.InputConstants;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.minecraft.client.KeyMapping;
import net.minecraft.resources.Identifier;
import org.lwjgl.glfw.GLFW;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * VTuber Bridge のエントリポイント。
 * 127.0.0.1:25599（-Dvtuberbridge.port で変更可）で待ち受け、AI VTuber側からの要求を受ける。
 * F8（変更可）で、人がいつでもAI操作を停止/再開できる。
 */
public final class BridgeMod implements ClientModInitializer {
    public static final Logger LOG = LoggerFactory.getLogger("vtuberbridge");

    private static BridgeServer server;
    private static Controller controller;

    @Override
    public void onInitializeClient() {
        int port = Integer.getInteger("vtuberbridge.port", 25599);
        server = new BridgeServer(port);
        controller = new Controller(server);

        KeyMapping.Category category = KeyMapping.Category.register(Identifier.fromNamespaceAndPath("vtuberbridge", "main"));
        KeyMapping toggleKey = KeyBindingHelper.registerKeyBinding(new KeyMapping(
                "key.vtuberbridge.toggle", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_F8, category));

        ClientTickEvents.END_CLIENT_TICK.register(mc -> {
            while (toggleKey.consumeClick()) {
                controller.toggleByHuman(mc);
            }
            controller.tick(mc);
        });
        ClientLifecycleEvents.CLIENT_STOPPING.register(mc -> {
            controller.cancel(mc, "client_stopping");
            server.shutdown();
        });
        server.start();
    }
}
