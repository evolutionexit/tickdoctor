package dev.tickdoctor.agent.model;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

/** Shared Gson (bundled with Paper). Nulls are omitted, which is how optional fields disappear. */
public final class Json {
    public static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    private Json() {}

    public static String toJson(Object o) {
        return GSON.toJson(o);
    }
}
