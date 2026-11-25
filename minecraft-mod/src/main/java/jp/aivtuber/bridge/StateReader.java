package jp.aivtuber.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import jp.aivtuber.bridge.action.Json;
import jp.aivtuber.bridge.action.Rot;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 配信画面のプレイヤーから、観測できる状態を読み取る。クライアントスレッドで呼ぶこと。 */
public final class StateReader {
    private static final int RADIUS = 12;
    private static final int DOWN = 6;
    private static final int UP = 10;
    private static final int MAX_BLOCK_TYPES = 24;
    private static final int MAX_ENTITIES = 12;
    private static final float HALF_FOV = 45f;

    private StateReader() {}

    /** ワールドID。シングルプレイはセーブフォルダ名、マルチはサーバーアドレス。 */
    public static String worldId(Minecraft mc) {
        MinecraftServer server = mc.getSingleplayerServer();
        if (server != null) {
            Path root = server.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize();
            Path name = root.getFileName();
            return "local:" + (name != null ? name.toString() : "world");
        }
        ServerData data = mc.getCurrentServer();
        if (data != null) return "server:" + data.ip;
        return "unknown";
    }

    public static JsonObject read(Minecraft mc, boolean aiEnabled, String currentAction) {
        JsonObject s = new JsonObject();
        s.addProperty("observed_at", Instant.now().toString());
        s.addProperty("ai_enabled", aiEnabled);
        s.addProperty("current_action", currentAction);
        LocalPlayer p = mc.player;
        ClientLevel level = mc.level;
        if (p == null || level == null) {
            s.addProperty("in_world", false);
            return s;
        }
        s.addProperty("in_world", true);
        s.addProperty("world_id", worldId(mc));
        s.addProperty("dimension", level.dimension().identifier().toString());
        s.addProperty("screen_open", mc.screen != null);
        s.addProperty("game_mode", mc.gameMode != null ? mc.gameMode.getPlayerMode().getName() : "unknown");

        JsonObject pos = Json.vec(p.position());
        s.add("pos", pos);
        s.add("block_pos", Json.pos(p.blockPosition()));
        JsonObject rot = new JsonObject();
        rot.addProperty("yaw", Json.round(Mth.wrapDegrees(p.getYRot())));
        rot.addProperty("pitch", Json.round(p.getXRot()));
        rot.addProperty("facing", Rot.compass(p.getYRot()));
        s.add("rotation", rot);
        s.addProperty("on_ground", p.onGround());
        s.addProperty("in_water", p.isInWater());
        s.addProperty("health", p.getHealth());
        s.add("inputs_held", inputsHeld(mc));

        BlockPos bp = p.blockPosition();
        s.addProperty("standing_on", blockId(level.getBlockState(bp.below())));
        s.addProperty("biome", level.getBiome(bp).unwrapKey().map(k -> k.identifier().toString()).orElse("unknown"));
        long dayTime = level.getDayTime() % 24000L;
        s.addProperty("day_time", dayTime);
        s.addProperty("time_of_day", timeOfDay(dayTime));
        s.addProperty("weather", level.isThundering() ? "thunder" : level.isRaining() ? "rain" : "clear");
        s.addProperty("sky_light", level.getBrightness(LightLayer.SKY, bp));
        s.addProperty("block_light", level.getBrightness(LightLayer.BLOCK, bp));

        s.add("looking_at", lookingAt(mc, p));
        s.add("surroundings", surroundings(level, p));
        return s;
    }

    /** 押下中の操作キー（停止後に入力が残っていないかの確認用）。 */
    private static JsonArray inputsHeld(Minecraft mc) {
        JsonArray a = new JsonArray();
        var o = mc.options;
        String[] names = {"forward", "back", "left", "right", "jump", "sneak", "sprint", "attack", "use"};
        net.minecraft.client.KeyMapping[] keys = {o.keyUp, o.keyDown, o.keyLeft, o.keyRight, o.keyJump,
                o.keyShift, o.keySprint, o.keyAttack, o.keyUse};
        for (int i = 0; i < keys.length; i++) if (keys[i].isDown()) a.add(names[i]);
        return a;
    }

    private static String timeOfDay(long t) {
        if (t < 1000) return "朝焼け";
        if (t < 6000) return "朝";
        if (t < 11000) return "昼";
        if (t < 12500) return "夕方";
        if (t < 13500) return "日没";
        if (t < 23000) return "夜";
        return "夜明け";
    }

    static String blockId(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    private static JsonObject lookingAt(Minecraft mc, LocalPlayer p) {
        JsonObject o = new JsonObject();
        HitResult hit = mc.hitResult;
        if (hit == null || hit.getType() == HitResult.Type.MISS) {
            // 届く範囲外も少し遠くまで見る（景色を眺めるため）
            HitResult far = p.pick(64.0, 0f, true);
            if (far instanceof BlockHitResult bh && far.getType() == HitResult.Type.BLOCK) {
                o.addProperty("type", "block");
                o.addProperty("block", blockId(p.level().getBlockState(bh.getBlockPos())));
                o.add("pos", Json.pos(bh.getBlockPos()));
                o.addProperty("distance", Json.round(p.getEyePosition().distanceTo(far.getLocation())));
                o.addProperty("in_reach", false);
            } else {
                o.addProperty("type", "sky_or_far");
            }
            return o;
        }
        if (hit instanceof BlockHitResult bh) {
            o.addProperty("type", "block");
            o.addProperty("block", blockId(p.level().getBlockState(bh.getBlockPos())));
            o.add("pos", Json.pos(bh.getBlockPos()));
            o.addProperty("face", bh.getDirection().getName());
            o.addProperty("in_reach", true);
        } else if (hit instanceof EntityHitResult eh) {
            o.addProperty("type", "entity");
            o.addProperty("entity", BuiltInRegistries.ENTITY_TYPE.getKey(eh.getEntity().getType()).toString());
            o.addProperty("name", eh.getEntity().getName().getString());
            o.addProperty("in_reach", true);
        }
        o.addProperty("distance", Json.round(p.getEyePosition().distanceTo(hit.getLocation())));
        return o;
    }

    private record Found(BlockPos pos, double dist) {}

    private static JsonObject surroundings(ClientLevel level, LocalPlayer p) {
        BlockPos center = p.blockPosition();
        Map<String, Integer> counts = new HashMap<>();
        Map<String, List<Found>> nearest = new HashMap<>();
        BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
        for (int dx = -RADIUS; dx <= RADIUS; dx++) {
            for (int dz = -RADIUS; dz <= RADIUS; dz++) {
                for (int dy = -DOWN; dy <= UP; dy++) {
                    m.set(center.getX() + dx, center.getY() + dy, center.getZ() + dz);
                    BlockState st = level.getBlockState(m);
                    if (st.isAir()) continue;
                    String id = blockId(st);
                    counts.merge(id, 1, Integer::sum);
                    double d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    List<Found> list = nearest.computeIfAbsent(id, k -> new ArrayList<>());
                    list.add(new Found(m.immutable(), d));
                    if (list.size() > 16) {
                        list.sort(Comparator.comparingDouble(Found::dist));
                        list.subList(4, list.size()).clear();
                    }
                }
            }
        }

        Vec3 eye = p.getEyePosition();
        float yaw = p.getYRot();
        float pitch = p.getXRot();
        JsonArray blocks = new JsonArray();
        counts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(MAX_BLOCK_TYPES)
                .forEach(e -> {
                    List<Found> list = nearest.get(e.getKey());
                    list.sort(Comparator.comparingDouble(Found::dist));
                    Found n = list.get(0);
                    boolean visible = false;
                    boolean inView = false;
                    for (int i = 0; i < Math.min(4, list.size()); i++) {
                        BlockPos bp = list.get(i).pos();
                        if (canSee(level, p, eye, bp)) {
                            visible = true;
                            if (inFov(eye, Vec3.atCenterOf(bp), yaw, pitch)) inView = true;
                        }
                    }
                    JsonObject b = new JsonObject();
                    b.addProperty("id", e.getKey());
                    b.addProperty("count", e.getValue());
                    b.add("nearest", Json.pos(n.pos()));
                    b.addProperty("distance", Json.round(n.dist()));
                    float ty = Rot.yawTo(eye, Vec3.atCenterOf(n.pos()));
                    b.addProperty("direction", Rot.compass(ty));
                    b.addProperty("relative", Rot.relative(yaw, ty));
                    b.addProperty("visible", visible);
                    b.addProperty("in_view", inView);
                    blocks.add(b);
                });

        JsonArray entities = new JsonArray();
        AABB box = p.getBoundingBox().inflate(24);
        List<Entity> found = level.getEntities(p, box, e -> e instanceof LivingEntity || e instanceof ItemEntity);
        found.sort(Comparator.comparingDouble(e -> e.distanceTo(p)));
        for (Entity e : found.subList(0, Math.min(MAX_ENTITIES, found.size()))) {
            JsonObject o = new JsonObject();
            o.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
            o.addProperty("name", e.getName().getString());
            o.add("pos", Json.vec(e.position()));
            o.addProperty("distance", Json.round(e.distanceTo(p)));
            float ty = Rot.yawTo(eye, e.getEyePosition());
            o.addProperty("direction", Rot.compass(ty));
            o.addProperty("relative", Rot.relative(yaw, ty));
            boolean visible = p.hasLineOfSight(e);
            o.addProperty("visible", visible);
            o.addProperty("in_view", visible && inFov(eye, e.getEyePosition(), yaw, pitch));
            entities.add(o);
        }

        JsonObject s = new JsonObject();
        s.addProperty("radius", RADIUS);
        s.add("blocks", blocks);
        s.add("entities", entities);
        return s;
    }

    /** 目からブロックまで遮るものがないか（そのブロック自身に当たれば見えている）。 */
    private static boolean canSee(ClientLevel level, LocalPlayer p, Vec3 eye, BlockPos target) {
        Vec3 to = Vec3.atCenterOf(target);
        BlockHitResult r = level.clip(new ClipContext(eye, to, ClipContext.Block.VISUAL, ClipContext.Fluid.ANY, p));
        return r.getType() == HitResult.Type.MISS || r.getBlockPos().equals(target);
    }

    private static boolean inFov(Vec3 eye, Vec3 target, float yaw, float pitch) {
        float ty = Rot.yawTo(eye, target);
        float tp = Rot.pitchTo(eye, target);
        return Math.abs(Mth.wrapDegrees(ty - yaw)) <= HALF_FOV && Math.abs(tp - pitch) <= HALF_FOV * 0.75f;
    }
}
