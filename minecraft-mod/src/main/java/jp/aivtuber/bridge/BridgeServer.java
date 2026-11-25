package jp.aivtuber.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * 同一PC内（127.0.0.1）だけで待ち受ける、1行1JSONの単純なTCPサーバー。
 * 受信したメッセージはキューに積み、Minecraftのクライアントスレッド（tick）で処理する。
 * 接続は同時に1つだけ。新しい接続が来たら古い接続は閉じる。
 */
public final class BridgeServer {
    /** 受信メッセージ。connectionId で、どの接続から来たかを区別する（切断後の古い要求を捨てるため）。 */
    public record Incoming(long connectionId, JsonObject message) {}

    private final int port;
    private final Queue<Incoming> inbox = new ConcurrentLinkedQueue<>();
    private volatile Socket client;
    private volatile long connectionId = 0;
    private volatile boolean running = true;
    private ServerSocket serverSocket;

    public BridgeServer(int port) {
        this.port = port;
    }

    public void start() {
        Thread t = new Thread(this::acceptLoop, "VTuberBridge-Accept");
        t.setDaemon(true);
        t.start();
    }

    public void shutdown() {
        running = false;
        closeClient();
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
    }

    public Queue<Incoming> inbox() {
        return inbox;
    }

    public long currentConnectionId() {
        return connectionId;
    }

    public boolean isConnected() {
        Socket c = client;
        return c != null && !c.isClosed();
    }

    private void acceptLoop() {
        try {
            serverSocket = new ServerSocket(port, 1, InetAddress.getLoopbackAddress());
            BridgeMod.LOG.info("[VTuberBridge] listening on 127.0.0.1:{}", port);
            while (running) {
                Socket s = serverSocket.accept();
                s.setTcpNoDelay(true);
                closeClient();
                long id = ++connectionId;
                client = s;
                inbox.add(new Incoming(id, internal("connected")));
                Thread reader = new Thread(() -> readLoop(s, id), "VTuberBridge-Reader-" + id);
                reader.setDaemon(true);
                reader.start();
            }
        } catch (IOException e) {
            if (running) BridgeMod.LOG.error("[VTuberBridge] server error", e);
        }
    }

    private void readLoop(Socket s, long id) {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                try {
                    JsonObject obj = JsonParser.parseString(line).getAsJsonObject();
                    inbox.add(new Incoming(id, obj));
                } catch (Exception e) {
                    JsonObject err = new JsonObject();
                    err.addProperty("type", "error");
                    err.addProperty("reason", "invalid_json");
                    send(err);
                }
            }
        } catch (SocketException ignored) {
            // 切断
        } catch (IOException e) {
            BridgeMod.LOG.warn("[VTuberBridge] read error: {}", e.toString());
        } finally {
            // 連携が切れたことをtick側へ知らせ、入力を解除させる
            inbox.add(new Incoming(id, internal("disconnected")));
            if (client == s) closeClient();
        }
    }

    private static JsonObject internal(String kind) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "_internal");
        o.addProperty("kind", kind);
        return o;
    }

    /** 現在の接続へ1行送る。どのスレッドからでも呼べる。 */
    public synchronized void send(JsonObject message) {
        Socket c = client;
        if (c == null || c.isClosed()) return;
        try {
            OutputStream out = c.getOutputStream();
            out.write((message.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (IOException e) {
            closeClient();
        }
    }

    private synchronized void closeClient() {
        Socket c = client;
        client = null;
        if (c != null) {
            try {
                c.close();
            } catch (IOException ignored) {
            }
        }
    }
}
