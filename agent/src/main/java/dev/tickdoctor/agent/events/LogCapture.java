package dev.tickdoctor.agent.events;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.atomic.AtomicLong;
import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.Logger;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.apache.logging.log4j.message.Message;

/**
 * Log4j appender on the root logger. It runs on whatever thread logs, so it only filters cheaply
 * (WARN+, "Can't keep up!" or a throwable) and enqueues into a bounded queue — dropping (and
 * counting) when full. Parsing happens async in {@link LogEvents}. Only collects while a runtime
 * is running ({@link #setActive}); while the agent is idle nothing drains the queue, so nothing is
 * kept.
 */
public final class LogCapture extends AbstractAppender {
    public record Raw(long millis, String logger, String message, Throwable thrown) {}

    private final ArrayBlockingQueue<Raw> queue = new ArrayBlockingQueue<>(1000);
    private final String ownLogger;
    private final AtomicLong dropped = new AtomicLong();
    private volatile boolean active;

    public LogCapture(String ownLogger) {
        super("TickDoctorCapture", null, null, true, Property.EMPTY_ARRAY);
        this.ownLogger = ownLogger;
    }

    @Override
    public void append(LogEvent e) {
        if (!active) return;
        try {
            if (!e.getLevel().isMoreSpecificThan(Level.WARN)) return;
            String logger = e.getLoggerName();
            if (logger != null && logger.equals(ownLogger)) return;
            Throwable t = e.getThrown();
            Message m = e.getMessage();
            String msg = m == null ? null : m.getFormattedMessage();
            if (t == null && (msg == null || !msg.contains("Can't keep up!"))) return;
            enqueue(new Raw(e.getInstant().getEpochMillisecond(), logger, msg, t));
        } catch (RuntimeException ignored) {
            // never break logging
        }
    }

    /**
     * Second half of {@link #append}, after the active check. An append can pass that check just
     * before {@link #setActive}(false) clears the queue, so the item is taken back out if the
     * capture went idle meanwhile.
     */
    void enqueue(Raw r) {
        if (!queue.offer(r)) {
            dropped.incrementAndGet();
            return;
        }
        if (!active) queue.remove(r);
    }

    public List<Raw> drain() {
        List<Raw> out = new ArrayList<>();
        queue.drainTo(out);
        return out;
    }

    /**
     * True while a runtime drains the queue; false (idle) stops collecting and clears what is
     * queued. Going active clears too, so nothing left over from an idle period is reported.
     */
    public void setActive(boolean on) {
        if (on) queue.clear();
        active = on;
        if (!on) queue.clear();
    }

    public boolean active() {
        return active;
    }

    /** Log lines that matched but were dropped because the queue was full. */
    public long dropped() {
        return dropped.get();
    }

    public void attach() {
        start();
        ((Logger) LogManager.getRootLogger()).addAppender(this);
    }

    public void detach() {
        try {
            ((Logger) LogManager.getRootLogger()).removeAppender(this);
        } finally {
            stop();
        }
    }
}
