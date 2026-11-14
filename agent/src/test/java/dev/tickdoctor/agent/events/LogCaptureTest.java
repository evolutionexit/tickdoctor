package dev.tickdoctor.agent.events;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.apache.logging.log4j.Level;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.impl.Log4jLogEvent;
import org.apache.logging.log4j.message.SimpleMessage;
import org.junit.jupiter.api.Test;

class LogCaptureTest {
    private static LogEvent warnWithThrowable(String logger) {
        return Log4jLogEvent.newBuilder().setLoggerName(logger).setLevel(Level.WARN)
                .setMessage(new SimpleMessage("boom")).setThrown(new IllegalStateException("x")).setTimeMillis(1_000).build();
    }

    @Test
    void collectsNothingWhileIdle() {
        LogCapture c = new LogCapture("TickDoctor");
        c.append(warnWithThrowable("SomePlugin"));
        assertTrue(c.drain().isEmpty(), "idle: not queued");
        c.setActive(true);
        c.append(warnWithThrowable("SomePlugin"));
        c.append(warnWithThrowable("TickDoctor")); // own logger ignored
        assertEquals(1, c.drain().size());
        c.append(warnWithThrowable("SomePlugin"));
        c.setActive(false);
        assertTrue(c.drain().isEmpty(), "going idle clears the queue");
        assertEquals(0, c.dropped());
    }

    @Test
    void countsDropsWhenTheQueueIsFull() {
        LogCapture c = new LogCapture("TickDoctor");
        c.setActive(true);
        for (int i = 0; i < 1_005; i++) c.append(warnWithThrowable("SomePlugin"));
        assertEquals(5, c.dropped());
        assertEquals(1_000, c.drain().size());
    }

    @Test
    void anAppendRacingWithGoingIdleLeavesNothingQueued() {
        LogCapture c = new LogCapture("TickDoctor");
        c.setActive(true);
        LogCapture.Raw raced = new LogCapture.Raw(1_000, "SomePlugin", "boom", new IllegalStateException());
        c.setActive(false);
        // the append passed the active check before setActive(false), and enqueues after the clear
        c.enqueue(raced);
        c.setActive(true);
        assertTrue(c.drain().isEmpty(), "the raced line is not reported");
        c.enqueue(raced);
        assertEquals(1, c.drain().size(), "while active it is kept");
    }
}
