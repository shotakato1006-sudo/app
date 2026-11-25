package jp.aivtuber.bridge;

import com.google.gson.JsonObject;
import jp.aivtuber.bridge.action.BreakBlockAction;
import jp.aivtuber.bridge.action.BridgeAction;
import jp.aivtuber.bridge.action.Inputs;
import jp.aivtuber.bridge.action.JumpAction;
import jp.aivtuber.bridge.action.LookAction;
import jp.aivtuber.bridge.action.MoveAction;
import jp.aivtuber.bridge.action.MoveToAction;
import jp.aivtuber.bridge.action.PlaceBlockAction;
import jp.aivtuber.bridge.action.WaitAction;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;

/**
 * 受信したメッセージを処理し、操作を1つずつ実行する。すべてクライアントスレッド（tick）で動く。
 *
 * 安全のための約束:
 *  - 操作は同時に1つ。終わったら同じ操作IDで結果を返す。
 *  - 人がF8で止めたとき、連携が切れたとき、ワールドを出たとき、画面（メニュー）が開いたときは、
 *    実行中の操作を中断し、押下中の入力をすべて解除する。
 */
public final class Controller {
    public static final int PROTOCOL = 1;

    private final BridgeServer server;
    private BridgeAction current;
    private String currentId;
    private long currentConnection;
    private boolean aiEnabled = true;
    private boolean wasInWorld;

    public Controller(BridgeServer server) {
        this.server = server;
    }

    public boolean aiEnabled() {
        return aiEnabled;
    }

    /** 人による停止/再開（キー操作）。 */
    public void toggleByHuman(Minecraft mc) {
        aiEnabled = !aiEnabled;
        if (!aiEnabled) {
            cancel(mc, "stopped_by_human");
        }
        JsonObject ev = event(aiEnabled ? "ai_enabled" : "ai_disabled");
        server.send(ev);
        if (mc.player != null) {
            mc.player.displayClientMessage(net.minecraft.network.chat.Component.literal(
                    aiEnabled ? "AI操作: 再開" : "AI操作: 停止（入力を解除しました）"), true);
        }
    }

    public void tick(Minecraft mc) {
        BridgeServer.Incoming in;
        while ((in = server.inbox().poll()) != null) {
            handle(mc, in);
        }

        LocalPlayer p = mc.player;
        boolean inWorld = p != null && mc.level != null;
        if (wasInWorld && !inWorld) {
            cancel(mc, "world_left");
            server.send(event("world_left"));
        } else if (!wasInWorld && inWorld) {
            JsonObject ev = event("world_joined");
            ev.addProperty("world_id", StateReader.worldId(mc));
            server.send(ev);
        }
        wasInWorld = inWorld;

        if (current == null || p == null) return;
        if (mc.screen != null) {
            cancel(mc, "screen_open");
            return;
        }
        BridgeAction.Status st;
        try {
            st = current.tick(mc, p);
        } catch (Exception e) {
            BridgeMod.LOG.error("[VTuberBridge] action error", e);
            finish(mc, p, false, "internal_error");
            return;
        }
        if (st == BridgeAction.Status.SUCCEEDED) finish(mc, p, true, null);
        else if (st == BridgeAction.Status.FAILED) finish(mc, p, false, current.failureReason());
    }

    private void handle(Minecraft mc, BridgeServer.Incoming in) {
        JsonObject msg = in.message();
        String type = msg.has("type") ? msg.get("type").getAsString() : "";
        String id = msg.has("id") && !msg.get("id").isJsonNull() ? msg.get("id").getAsString() : null;

        if (type.equals("_internal")) {
            String kind = msg.get("kind").getAsString();
            if (kind.equals("disconnected") && in.connectionId() == currentConnection) {
                cancel(mc, "connection_lost");
            } else if (kind.equals("disconnected") && current == null) {
                Inputs.releaseAll(mc);
            }
            return;
        }
        // 切断済みの古い接続からの要求は捨てる
        if (in.connectionId() != server.currentConnectionId()) return;

        switch (type) {
            case "hello" -> {
                JsonObject r = reply("hello", id);
                r.addProperty("protocol", PROTOCOL);
                r.addProperty("mod", "vtuberbridge");
                r.addProperty("ai_enabled", aiEnabled);
                r.addProperty("world_id", mc.level != null ? StateReader.worldId(mc) : null);
                server.send(r);
            }
            case "get_state" -> {
                JsonObject r = reply("state", id);
                r.add("state", StateReader.read(mc, aiEnabled, current != null ? current.name() : null));
                server.send(r);
            }
            case "stop" -> {
                cancel(mc, "stopped_by_client");
                Inputs.releaseAll(mc);
                server.send(reply("stopped", id));
            }
            case "act" -> startAction(mc, in.connectionId(), id, msg);
            default -> {
                JsonObject r = reply("error", id);
                r.addProperty("reason", "unknown_type");
                server.send(r);
            }
        }
    }

    private void startAction(Minecraft mc, long connection, String id, JsonObject msg) {
        String actionName = msg.has("action") ? msg.get("action").getAsString() : "";
        JsonObject args = msg.has("args") && msg.get("args").isJsonObject() ? msg.getAsJsonObject("args") : new JsonObject();
        LocalPlayer p = mc.player;

        String reject = null;
        if (id == null) reject = "missing_id";
        else if (!aiEnabled) reject = "ai_disabled";
        else if (p == null || mc.level == null) reject = "not_in_world";
        else if (mc.screen != null) reject = "screen_open";
        else if (current != null) reject = "busy";
        else if (msg.has("world_id") && !msg.get("world_id").getAsString().equals(StateReader.worldId(mc))) {
            reject = "world_mismatch";
        }

        BridgeAction action = null;
        if (reject == null) {
            action = switch (actionName) {
                case "look" -> new LookAction(args);
                case "move" -> new MoveAction(args);
                case "move_to" -> new MoveToAction(args);
                case "jump" -> new JumpAction();
                case "wait" -> new WaitAction(args);
                case "place_block" -> new PlaceBlockAction(args);
                case "break_block" -> new BreakBlockAction(args);
                default -> null;
            };
            if (action == null) reject = "unsupported_action";
        }
        if (reject == null) {
            try {
                reject = action.start(mc, p);
            } catch (Exception e) {
                BridgeMod.LOG.error("[VTuberBridge] start error", e);
                reject = "invalid_args";
            }
        }
        if (reject != null) {
            if (action != null) action.release(mc);
            JsonObject r = reply("result", id);
            r.addProperty("action", actionName);
            r.addProperty("ok", false);
            r.addProperty("reason", reject);
            server.send(r);
            return;
        }
        current = action;
        currentId = id;
        currentConnection = connection;
        JsonObject r = reply("accepted", id);
        r.addProperty("action", actionName);
        server.send(r);
    }

    private void finish(Minecraft mc, LocalPlayer p, boolean ok, String reason) {
        BridgeAction a = current;
        String id = currentId;
        current = null;
        currentId = null;
        a.release(mc);
        JsonObject r = reply("result", id);
        r.addProperty("action", a.name());
        r.addProperty("ok", ok);
        if (reason != null) r.addProperty("reason", reason);
        try {
            r.add("observed", a.observed(mc, p));
        } catch (Exception e) {
            BridgeMod.LOG.warn("[VTuberBridge] observe error: {}", e.toString());
        }
        server.send(r);
    }

    /** 実行中の操作を中断し、入力を解除する。 */
    public void cancel(Minecraft mc, String reason) {
        if (current == null) {
            Inputs.releaseAll(mc);
            return;
        }
        LocalPlayer p = mc.player;
        if (p != null) {
            finish(mc, p, false, reason);
        } else {
            BridgeAction a = current;
            String id = currentId;
            current = null;
            currentId = null;
            a.release(mc);
            JsonObject r = reply("result", id);
            r.addProperty("action", a.name());
            r.addProperty("ok", false);
            r.addProperty("reason", reason);
            server.send(r);
        }
        Inputs.releaseAll(mc);
    }

    private static JsonObject reply(String type, String id) {
        JsonObject r = new JsonObject();
        r.addProperty("type", type);
        if (id != null) r.addProperty("id", id);
        return r;
    }

    private static JsonObject event(String name) {
        JsonObject r = new JsonObject();
        r.addProperty("type", "event");
        r.addProperty("event", name);
        return r;
    }
}
