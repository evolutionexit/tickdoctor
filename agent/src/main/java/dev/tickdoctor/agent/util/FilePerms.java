package dev.tickdoctor.agent.util;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;

/**
 * Owner-only permissions for the files the agent creates (config.yml holds the API key; buffer
 * batches are private too). Best effort: on Windows / non-POSIX filesystems every
 * method is a no-op and nothing here ever throws.
 */
public final class FilePerms {
    private FilePerms() {}

    public static final Set<PosixFilePermission> FILE = PosixFilePermissions.fromString("rw-------");
    public static final Set<PosixFilePermission> DIR = PosixFilePermissions.fromString("rwx------");

    /** Sets 600 on a file or 700 on a directory; false if not applied (non-POSIX, missing, error). */
    public static boolean ownerOnly(Path p) {
        try {
            Set<PosixFilePermission> want = Files.isDirectory(p) ? DIR : FILE;
            if (!Files.getPosixFilePermissions(p).equals(want)) Files.setPosixFilePermissions(p, want);
            return true;
        } catch (UnsupportedOperationException | IOException | SecurityException e) {
            return false;
        }
    }

    /** Like {@link Files#createDirectories} but newly created directories get 700. */
    public static void createPrivateDirectories(Path dir) throws IOException {
        Path abs = dir.toAbsolutePath();
        if (Files.isDirectory(abs)) return;
        Path parent = abs.getParent();
        if (parent != null) createPrivateDirectories(parent);
        try {
            Files.createDirectory(abs);
        } catch (java.nio.file.FileAlreadyExistsException e) {
            return;
        }
        ownerOnly(abs);
    }

    /** File attribute for creating owner-only files; empty array on non-POSIX filesystems. */
    public static FileAttribute<?>[] fileAttr(Path dir) {
        try {
            if (Files.getFileStore(dir).supportsFileAttributeView("posix")) {
                return new FileAttribute<?>[] {PosixFilePermissions.asFileAttribute(FILE)};
            }
        } catch (IOException | SecurityException ignored) {
            // fall through
        }
        return new FileAttribute<?>[0];
    }

    /**
     * Writes {@code bytes} to {@code file}, creating it owner-only (600) from the start; parent
     * directories it creates get 700. Replaces an existing file's content but keeps its mode.
     */
    public static void writePrivate(Path file, byte[] bytes) throws IOException {
        Path parent = file.toAbsolutePath().getParent();
        if (parent != null) createPrivateDirectories(parent);
        boolean existed = Files.exists(file);
        try (var ch = Files.newByteChannel(file, Set.of(java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.WRITE,
                java.nio.file.StandardOpenOption.TRUNCATE_EXISTING), existed || parent == null ? new FileAttribute<?>[0] : fileAttr(parent))) {
            java.nio.ByteBuffer buf = java.nio.ByteBuffer.wrap(bytes);
            while (buf.hasRemaining()) ch.write(buf);
        }
        if (!existed) ownerOnly(file); // umask can't widen it, but be explicit
    }

    /** Creates {@code file} owner-only with {@code bytes} unless it exists; true if created. */
    public static boolean createPrivateIfAbsent(Path file, byte[] bytes) throws IOException {
        if (Files.exists(file)) return false;
        writePrivate(file, bytes);
        return true;
    }

    /** "group", "world" if others beyond the owner can read the file, else null (also on non-POSIX). */
    public static String readableBeyondOwner(Path p) {
        try {
            Set<PosixFilePermission> perms = Files.getPosixFilePermissions(p);
            if (perms.contains(PosixFilePermission.OTHERS_READ)) return "world";
            if (perms.contains(PosixFilePermission.GROUP_READ)) return "group";
            return null;
        } catch (UnsupportedOperationException | IOException | SecurityException e) {
            return null;
        }
    }
}
