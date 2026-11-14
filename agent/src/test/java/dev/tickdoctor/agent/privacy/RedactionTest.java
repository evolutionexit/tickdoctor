package dev.tickdoctor.agent.privacy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.Set;
import org.junit.jupiter.api.Test;

class RedactionTest {
    @Test
    void redactsSensitiveFlagValues() {
        assertEquals("-Ddb.password=***", Redaction.redactFlag("-Ddb.password=hunter2"));
        assertEquals("-DAPI_TOKEN=***", Redaction.redactFlag("-DAPI_TOKEN=abc"));
        assertEquals("-Dmy.Secret.thing=***", Redaction.redactFlag("-Dmy.Secret.thing=x=y"));
        assertEquals("-Djavax.net.ssl.keyStorePassword=***", Redaction.redactFlag("-Djavax.net.ssl.keyStorePassword=changeit"));
        assertEquals("-Dlicense.key=***", Redaction.redactFlag("-Dlicense.key=AAAA-BBBB"));
        assertEquals("-Dauth=***", Redaction.redactFlag("-Dauth=mysecretvalue"));
        assertEquals("-Dx=***", Redaction.redactFlag("-Dx=td_live_abcDEF123"));
    }

    @Test
    void leavesNormalFlagsAlone() {
        for (String f : new String[] {"-Xms1G", "-Xmx3G", "-Xss1M", "-XX:+UseG1GC", "-XX:MaxGCPauseMillis=200",
                "-XX:+ParallelRefProcEnabled", "-Dusing.aikars.flags=https://mcflags.emc.gs", "-Daikars.new.flags=true",
                "--add-modules=jdk.incubator.vector", "-Xlog:gc*=info:stdout:time,uptime", "-Xlog:gc", "-Dcom.mojang.eula.agree"}) {
            assertEquals(f, Redaction.redactFlag(f));
        }
    }

    // ---------- audit M1: JVM flags allow-list ----------

    @Test
    void auditFlagExamplesAreNeutralised() {
        assertEquals("-Ddb.pass=***", Redaction.redactFlag("-Ddb.pass=x"));
        assertEquals("-Drcon.pass=***", Redaction.redactFlag("-Drcon.pass=x"));
        assertEquals("-Djava.rmi.server.hostname=***", Redaction.redactFlag("-Djava.rmi.server.hostname=203.0.113.5"));
        assertEquals("-Djdbc.url=***", Redaction.redactFlag("-Djdbc.url=mysql://root:pw@host/db"));
        assertNull(Redaction.redactFlag("-javaagent:/home/alice/x.jar"));
    }

    @Test
    void everyNonAllowListedPropertyLosesItsValue() {
        assertEquals("-Dfile.encoding=***", Redaction.redactFlag("-Dfile.encoding=UTF-8"));
        assertEquals("-Dwebhook=***", Redaction.redactFlag("-Dwebhook=https://discord.com/api/webhooks/1/abc"));
        assertEquals("-Dpaper.foo=***", Redaction.redactFlag("-Dpaper.foo=bar"));
    }

    @Test
    void pathCarryingFlagsAndHomeFoldersAreDropped() {
        for (String f : new String[] {"-javaagent:/opt/agents/x.jar", "-agentpath:/opt/token-agent.so",
                "-agentlib:jdwp=transport=dt_socket,server=y,address=0.0.0.0:5005", "-classpath", "-cp", "-jar",
                "-Xbootclasspath/a:/opt/x.jar", "-Xlog:gc:file=/home/alice/logs/gc.log", "-XX:HeapDumpPath=/Users/bob/dumps",
                "-XX:HeapDumpPath=C:\\Users\\Carol\\dumps", "/home/alice/server/paper.jar", "", "plain"}) {
            assertNull(Redaction.redactFlag(f), f);
        }
    }

    @Test
    void keptFlagsLoseIpsKeysAndSensitiveValues() {
        assertEquals("-XX:Foo=***", Redaction.redactFlag("-XX:Foo=my-credential-file"));
        assertEquals("-XX:SomeCommand=curl <ip>", Redaction.redactFlag("-XX:SomeCommand=curl 203.0.113.5"));
        assertEquals("-XX:Other=curl http://***@x.example/hook", Redaction.redactFlag("-XX:Other=curl http://u:pw@x.example/hook"));
        assertEquals("--weird=***", Redaction.redactFlag("--weird=value"));
        assertEquals("-Dtd=***", Redaction.redactFlag("-Dtd=x"));
    }

    @Test
    void redactFlagsDropsNulls() {
        assertEquals(java.util.List.of("-Xmx4G", "-XX:+UseG1GC", "-Ddb.pass=***", "-Dusing.aikars.flags=https://mcflags.emc.gs"),
                Redaction.redactFlags(java.util.List.of("-Xmx4G", "-javaagent:/home/alice/x.jar", "-XX:+UseG1GC", "-Ddb.pass=x",
                        "-Dusing.aikars.flags=https://mcflags.emc.gs")));
    }

    @Test
    void removesIpAddressesFromText() {
        assertEquals("Disconnected /<ip>:51234 (timeout)", Redaction.redactIps("Disconnected /192.168.4.224:51234 (timeout)"));
        assertEquals("from <ip> and <ip>", Redaction.redactIps("from 2001:db8::1 and fe80:0:0:0:200:f8ff:fe21:67cf"));
        assertEquals("loopback <ip>", Redaction.redactIps("loopback ::1"));
        // not addresses
        assertEquals("at 10:20:30 v1.2.3 build 26.2.83", Redaction.redactIps("at 10:20:30 v1.2.3 build 26.2.83"));
        assertFalse(Redaction.redactIps("key td_live_ABCdef123").contains("td_live_ABC"));
    }

    @Test
    void redactsDashedAndUndashedUuids() {
        assertEquals("Player <uuid> not found", Redaction.redactText("Player 069a79f4-44e9-4726-a5be-fca90e38aaf5 not found", Set.of()));
        assertEquals("id=<uuid>!", Redaction.redactText("id=069A79F444E94726A5BEFCA90E38AAF5!", Set.of()));
        assertEquals("short deadbeef stays", Redaction.redactText("short deadbeef stays", Set.of()));
    }

    @Test
    void redactsOnlinePlayerNames() {
        Set<String> names = Set.of("Notch", "jeb_");
        assertEquals("Could not teleport <player> to <player>", Redaction.redactText("Could not teleport notch to jeb_", names));
        assertEquals("Notchy and xjeb_ stay", Redaction.redactText("Notchy and xjeb_ stay", names));
        assertEquals("<player>: null", Redaction.redactText("Notch: null", names));
        assertEquals("Notch: null", Redaction.redactText("Notch: null", Set.of()));
    }

    @Test
    void redactsKeyValueSecrets() {
        assertEquals("GET /x?user=a&password=***&b=1", Redaction.redactText("GET /x?user=a&password=hunter2&b=1", Set.of()));
        assertEquals("token=*** pwd=*** API_KEY=*** mykey=***", Redaction.redactText("token=abc pwd=x API_KEY=y mykey=z", Set.of()));
        assertEquals("secret=*** apikey=***", Redaction.redactText("secret=s3 apikey=k", Set.of()));
    }

    @Test
    void textRedactionStillRemovesIpsAndApiKeys() {
        assertEquals("from <ip> with ***", Redaction.redactText("from 10.0.0.5 with td_live_abc123", Set.of()));
    }


    // ---------- audit M2: free text ----------

    @Test
    void redactsHomeFolderNamesInText() {
        assertEquals("java.io.FileNotFoundException: /home/~/server/x (No such file or directory)",
                Redaction.redactText("java.io.FileNotFoundException: /home/alice/server/x (No such file or directory)", Set.of()));
        assertEquals("cannot read /Users/~/mc/world/level.dat", Redaction.redactText("cannot read /Users/bob/mc/world/level.dat", Set.of()));
        assertEquals("C:\\Users\\~\\Desktop\\server\\x.yml", Redaction.redactText("C:\\Users\\Alice Smith\\Desktop\\server\\x.yml", Set.of()));
        assertEquals("D:/Users/~/x", Redaction.redactText("D:/Users/carol/x", Set.of()));
        assertEquals("/opt/minecraft/server/x stays", Redaction.redactText("/opt/minecraft/server/x stays", Set.of()));
    }

    @Test
    void redactsUrlCredentialsInText() {
        assertEquals("Access denied for jdbc:mysql://***@db/x", Redaction.redactText("Access denied for jdbc:mysql://root:Secr3t@db/x", Set.of()));
        assertEquals("proxy http://***@proxy.local:3128 failed", Redaction.redactText("proxy http://user@proxy.local:3128 failed", Set.of()));
        assertEquals("GET https://example.com/a@b stays", Redaction.redactText("GET https://example.com/a@b stays", Set.of()));
    }

    @Test
    void redactsColonAndSpacedSecretsInText() {
        assertEquals("Login failed, password=***", Redaction.redactText("Login failed, password: hunter2", Set.of()));
        assertEquals("pass=*** token=*** secret=*** pwd=***",
                Redaction.redactText("pass=abc token = t0k secret:s3 pwd: x", Set.of()));
        assertEquals("Key=*** in config", Redaction.redactText("Key: abc123 in config", Set.of()));
        // keyword inside a longer word is not a secret label
        assertEquals("bypass: on, monkey: banana", Redaction.redactText("bypass: on, monkey: banana", Set.of()));
    }

    @Test
    void exceptionMessagesAndFramesAreRedacted() {
        Exception e = new java.io.FileNotFoundException("/home/alice/server/plugins/x/config.yml (password: hunter2)");
        e.setStackTrace(new StackTraceElement[] {new StackTraceElement("app", null, null, "a.B", "c", "/home/alice/B.java", 1)});
        var ev = dev.tickdoctor.agent.events.LogEvents.exception(0, "x", "m", e, null);
        assertEquals("/home/~/server/plugins/x/config.yml (password=***", ev.message());
        assertFalse(ev.topFrames().get(0).contains("alice"), ev.topFrames().get(0));
    }

    // ---------- review round 2: camelCase, JSON, Authorization / Bearer ----------

    @Test
    void redactsCamelCaseSecretKeys() {
        assertEquals("apiKey=*** dbPassword=*** authToken=***", Redaction.redactText("apiKey: x dbPassword: hunter2 authToken: y", Set.of()));
        assertEquals("cfg.mysqlPassword=*** done", Redaction.redactText("cfg.mysqlPassword=s3cr3t done", Set.of()));
        // lowercase compounds are not labels
        assertEquals("bypass: on, monkey: banana, keyboard: qwerty", Redaction.redactText("bypass: on, monkey: banana, keyboard: qwerty", Set.of()));
    }

    @Test
    void redactsJsonSecrets() {
        assertEquals("{\"user\":\"a\",\"password\":\"***\",\"n\":1}", Redaction.redactText("{\"user\":\"a\",\"password\":\"hun ter2\",\"n\":1}", Set.of()));
        assertEquals("{'apiKey': '***'}", Redaction.redactText("{'apiKey': 'abc'}", Set.of()));
        assertEquals("{\"token\":\"***\"}", Redaction.redactText("{\"token\":\"a\\\"b\"}", Set.of()));
        assertEquals("{\"secret=***", Redaction.redactText("{\"secret\": 12345}", Set.of()));
    }

    @Test
    void redactsAuthorizationAndBearerTokens() {
        assertEquals("Authorization: Bearer *** rest", Redaction.redactText("Authorization: Bearer eyJhbGciOi.J9x-y_z rest", Set.of()));
        assertEquals("authorization=Basic ***", Redaction.redactText("authorization=Basic dXNlcjpwYXNz", Set.of()));
        assertEquals("\"Authorization\": \"***\"", Redaction.redactText("\"Authorization\": \"abc123\"", Set.of()));
        assertEquals("sent Bearer *** to x", Redaction.redactText("sent Bearer td_live_abc123 to x", Set.of()));
        assertEquals("the bearer of bad news", Redaction.redactText("the bearer of bad news", Set.of()));
    }

    // ---------- review round 2: command / path values in -XX and -Xlog ----------

    @Test
    void commandAndPathOptionsLoseTheirValue() {
        assertEquals("-XX:OnOutOfMemoryError=***", Redaction.redactFlag("-XX:OnOutOfMemoryError=kill -9 %p; curl http://203.0.113.5/x"));
        assertEquals("-XX:OnError=***", Redaction.redactFlag("-XX:OnError=gdb - %p"));
        assertEquals("-XX:ErrorFile=***", Redaction.redactFlag("-XX:ErrorFile=/srv/mc/hs_err_%p.log"));
        assertEquals("-XX:HeapDumpPath=***", Redaction.redactFlag("-XX:HeapDumpPath=/srv/dumps"));
        assertEquals("-XX:FlightRecorderOptions=***", Redaction.redactFlag("-XX:FlightRecorderOptions=repository=/srv/jfr"));
        assertEquals("-XX:StartFlightRecording=***", Redaction.redactFlag("-XX:StartFlightRecording=duration=60s,filename=/srv/rec.jfr"));
        assertEquals("-Xloggc:***", Redaction.redactFlag("-Xloggc:/srv/mc/gc.log"));
        assertEquals("-XX:+HeapDumpOnOutOfMemoryError", Redaction.redactFlag("-XX:+HeapDumpOnOutOfMemoryError"));
    }

    @Test
    void xlogKeepsTagsAndDecorationsButNotTheFile() {
        assertEquals("-Xlog:gc*:file=***:time,uptime:filecount=5,filesize=1M",
                Redaction.redactFlag("-Xlog:gc*:file=/opt/mc/logs/gc.log:time,uptime:filecount=5,filesize=1M"));
        assertEquals("-Xlog:gc*:file=***", Redaction.redactFlag("-Xlog:gc*:file=/opt/mc/logs/gc.log"));
        assertEquals("-Xlog:gc+heap=debug:file=***", Redaction.redactFlag("-Xlog:gc+heap=debug:gc.log"));
        assertEquals("-Xlog:safepoint:stderr::filecount=0", Redaction.redactFlag("-Xlog:safepoint:stderr::filecount=0"));
        assertEquals("-Xlog:gc:file=***", Redaction.redactFlag("-Xlog:gc:file=C:\\srv\\gc.log:uptime"));
        assertEquals("-Xlog:disable", Redaction.redactFlag("-Xlog:disable"));
    }
}
