package dev.tickdoctor.agent.util;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import dev.tickdoctor.agent.transport.DiskBuffer;
import dev.tickdoctor.agent.transport.Kind;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FilePermsTest {
    @TempDir Path dir;

    @BeforeEach
    void posixOnly() throws Exception {
        assumeTrue(Files.getFileStore(dir).supportsFileAttributeView("posix"), "POSIX filesystem");
    }

    private static String mode(Path p) throws Exception {
        return PosixFilePermissions.toString(Files.getPosixFilePermissions(p));
    }

    @Test
    void newConfigAndFolderAreOwnerOnly() throws Exception {
        Path data = dir.resolve("plugins/TickDoctor");
        Path cfg = data.resolve("config.yml");
        assertTrue(FilePerms.createPrivateIfAbsent(cfg, "api-key: \"\"\n".getBytes(StandardCharsets.UTF_8)));
        assertEquals("rw-------", mode(cfg));
        assertEquals("rwx------", mode(data));
        assertEquals("api-key: \"\"\n", Files.readString(cfg));
        assertNull(FilePerms.readableBeyondOwner(cfg));
    }

    @Test
    void existingConfigIsLeftAlone() throws Exception {
        Path cfg = dir.resolve("config.yml");
        Files.writeString(cfg, "api-key: td_live_x\n");
        Files.setPosixFilePermissions(cfg, PosixFilePermissions.fromString("rw-rw-r--"));
        assertFalse(FilePerms.createPrivateIfAbsent(cfg, new byte[0]));
        assertEquals("api-key: td_live_x\n", Files.readString(cfg));
        assertEquals("rw-rw-r--", mode(cfg), "user's own mode is not touched");
    }

    @Test
    void readableBeyondOwnerDistinguishesGroupAndWorld() throws Exception {
        Path f = Files.writeString(dir.resolve("f"), "x");
        Files.setPosixFilePermissions(f, PosixFilePermissions.fromString("rw-rw-r--"));
        assertEquals("world", FilePerms.readableBeyondOwner(f));
        Files.setPosixFilePermissions(f, PosixFilePermissions.fromString("rw-r-----"));
        assertEquals("group", FilePerms.readableBeyondOwner(f));
        Files.setPosixFilePermissions(f, PosixFilePermissions.fromString("rw-------"));
        assertNull(FilePerms.readableBeyondOwner(f));
        assertNull(FilePerms.readableBeyondOwner(dir.resolve("missing")), "never throws");
    }

    @Test
    void ownerOnlyNeverThrows() {
        assertFalse(FilePerms.ownerOnly(dir.resolve("missing")));
    }

    @Test
    void bufferDirAndBatchesAreOwnerOnly() throws Exception {
        Path buf = dir.resolve("buffer");
        DiskBuffer disk = new DiskBuffer(buf, 1_000_000);
        disk.append(Kind.METRICS, List.of("{\"n\":1}"));
        assertEquals("rwx------", mode(buf));
        try (Stream<Path> s = Files.list(buf)) {
            List<Path> files = s.toList();
            assertFalse(files.isEmpty());
            for (Path p : files) assertEquals("rw-------", mode(p), p.toString());
        }
    }
}
