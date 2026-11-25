package jp.aivtuber.bridge.action;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

public final class Json {
    private Json() {}

    public static double round(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    public static JsonObject vec(Vec3 v) {
        JsonObject o = new JsonObject();
        o.addProperty("x", round(v.x));
        o.addProperty("y", round(v.y));
        o.addProperty("z", round(v.z));
        return o;
    }

    public static JsonObject pos(BlockPos p) {
        JsonObject o = new JsonObject();
        o.addProperty("x", p.getX());
        o.addProperty("y", p.getY());
        o.addProperty("z", p.getZ());
        return o;
    }

    public static double num(JsonObject args, String key, double def) {
        return args != null && args.has(key) && !args.get(key).isJsonNull() ? args.get(key).getAsDouble() : def;
    }

    public static boolean bool(JsonObject args, String key, boolean def) {
        return args != null && args.has(key) && !args.get(key).isJsonNull() ? args.get(key).getAsBoolean() : def;
    }

    public static String str(JsonObject args, String key, String def) {
        return args != null && args.has(key) && !args.get(key).isJsonNull() ? args.get(key).getAsString() : def;
    }

    public static boolean has(JsonObject args, String key) {
        return args != null && args.has(key) && !args.get(key).isJsonNull();
    }
}
