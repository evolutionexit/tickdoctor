plugins {
    java
}

group = "dev.tickdoctor"
version = "0.1.6"

base {
    archivesName.set("tickdoctor-agent")
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(25))
    }
}

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

val paperApi = "io.papermc.paper:paper-api:26.2.build.83-stable"

dependencies {
    // Provided by the server at runtime: Paper API (incl. Gson, SnakeYAML) and Log4j core.
    // Nothing is shaded, so the jar has zero bundled dependencies.
    compileOnly(paperApi)
    compileOnly("org.apache.logging.log4j:log4j-core:2.26.0")

    testImplementation(paperApi)
    testImplementation("org.apache.logging.log4j:log4j-core:2.26.0") // LogCapture tests (provided by the server at runtime)
    testImplementation(platform("org.junit:junit-bom:5.13.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // Test-only: validates our serialized payloads against docs/contracts/ingest.schema.json.
    testImplementation("com.networknt:json-schema-validator:1.5.9")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release.set(25)
    options.compilerArgs.addAll(listOf("-Xlint:all,-processing,-serial", "-Werror"))
}

tasks.processResources {
    val props = mapOf("version" to project.version)
    inputs.properties(props)
    filesMatching("plugin.yml") { expand(props) }
}

tasks.test {
    useJUnitPlatform()
    systemProperty("tickdoctor.schema", rootDir.resolve("../docs/contracts/ingest.schema.json").absolutePath)
    inputs.file(rootDir.resolve("../docs/contracts/ingest.schema.json"))
    // optional: validate request bodies captured from a real server (see agent/README.md)
    System.getenv("TICKDOCTOR_BODIES")?.let {
        systemProperty("tickdoctor.bodies", it)
        outputs.upToDateWhen { false }
    }
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

tasks.jar {
    manifest {
        attributes("Implementation-Title" to "TickDoctor agent", "Implementation-Version" to project.version)
    }
}

