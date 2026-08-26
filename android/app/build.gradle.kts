import org.gradle.api.GradleException
import org.gradle.api.tasks.Copy
import org.gradle.api.tasks.Exec

plugins {
  id("com.android.application")
}

val repoRoot = rootProject.projectDir.parentFile
val pluginName = "olainkplugin"
val configuredVersionCode = providers.gradleProperty("olainkVersionCode").orNull
val versionCodeValue = configuredVersionCode?.toIntOrNull() ?: 2
require(configuredVersionCode == null || versionCodeValue > 0) {
  "olainkVersionCode must be a positive integer"
}
val versionNameValue = providers.gradleProperty("olainkVersionName").orNull ?: "0.0.2"

/**
 * Builds one plugin archive for one companion action. Variant-local directories
 * keep debug and release builds from overwriting each other's embedded plugin.
 */
fun registerPluginAssets(variant: String, companionAction: String, pluginVersionName: String) = run {
  val outputDir = layout.buildDirectory.dir("generated/olaink-plugin/$variant/output")
  val generatedDir = layout.buildDirectory.dir("generated/olaink-plugin/$variant/generated")
  val assetDir = layout.buildDirectory.dir("generated/olaink-plugin-assets/$variant")
  val archive = outputDir.map { it.file("$pluginName.snplg") }

  val build = tasks.register<Exec>("buildOlainkPlugin${variant.replaceFirstChar { it.uppercase() }}") {
    workingDir = repoRoot
    commandLine("npm", "run", "build:plugin")
    environment("OLAINK_COMPANION_SHARE_ACTION", companionAction)
    environment("OLAINK_PLUGIN_VERSION_NAME", pluginVersionName)
    environment("OLAINK_PLUGIN_VERSION_CODE", versionCodeValue.toString())
    environment("OLAINK_PLUGIN_OUTPUT_DIR", outputDir.get().asFile.absolutePath)
    environment("OLAINK_PLUGIN_GENERATED_DIR", generatedDir.get().asFile.absolutePath)
  }
  val stage = tasks.register<Copy>("stageOlainkPlugin${variant.replaceFirstChar { it.uppercase() }}") {
    dependsOn(build)
    from(archive)
    into(assetDir)
  }
  assetDir to stage
}

val (debugPluginAssets, stageDebugPlugin) = registerPluginAssets(
  "debug", "com.olaink.OPEN_SHARE.dev", "$versionNameValue-dev")
val (releasePluginAssets, stageReleasePlugin) = registerPluginAssets(
  "release", "com.olaink.OPEN_SHARE", versionNameValue)

val releaseStoreFile = providers.gradleProperty("olainkReleaseStoreFile")
    .orElse(providers.environmentVariable("OLAINK_RELEASE_STORE_FILE"))
val releaseStorePassword = providers.gradleProperty("olainkReleaseStorePassword")
    .orElse(providers.environmentVariable("OLAINK_RELEASE_STORE_PASSWORD"))
val releaseKeyAlias = providers.gradleProperty("olainkReleaseKeyAlias")
    .orElse(providers.environmentVariable("OLAINK_RELEASE_KEY_ALIAS"))
val releaseKeyPassword = providers.gradleProperty("olainkReleaseKeyPassword")
    .orElse(providers.environmentVariable("OLAINK_RELEASE_KEY_PASSWORD"))
val releaseSigningInputs = mapOf(
  "olainkReleaseStoreFile" to releaseStoreFile,
  "olainkReleaseStorePassword" to releaseStorePassword,
  "olainkReleaseKeyAlias" to releaseKeyAlias,
  "olainkReleaseKeyPassword" to releaseKeyPassword,
)
android {
  namespace = "com.olaink"
  compileSdk = 35

  buildFeatures {
    buildConfig = true
  }

  sourceSets.getByName("debug").assets.srcDir(debugPluginAssets)
  sourceSets.getByName("release").assets.srcDir(releasePluginAssets)

  defaultConfig {
    applicationId = "com.olaink"
    minSdk = 23
    targetSdk = 35
    versionCode = versionCodeValue
    versionName = versionNameValue
    manifestPlaceholders["companionShareAction"] = "com.olaink.OPEN_SHARE"
    buildConfigField("String", "COMPANION_SHARE_ACTION", "\"com.olaink.OPEN_SHARE\"")
    manifestPlaceholders["companionDeepLinkScheme"] = "olaink-player"
    manifestPlaceholders["appLabel"] = "Ola Ink"
  }

  signingConfigs {
    create("release") {
      // Empty values are deliberate for local debug builds. validateReleaseSigning
      // makes a requested release build fail instead of falling back to debug.
      releaseStoreFile.orNull?.let { storeFile = file(it) }
      releaseStorePassword.orNull?.let { storePassword = it }
      releaseKeyAlias.orNull?.let { keyAlias = it }
      releaseKeyPassword.orNull?.let { keyPassword = it }
    }
  }

  buildTypes {
    getByName("debug") {
      applicationIdSuffix = ".dev"
      versionNameSuffix = "-dev"
      manifestPlaceholders["companionShareAction"] = "com.olaink.OPEN_SHARE.dev"
      buildConfigField("String", "COMPANION_SHARE_ACTION", "\"com.olaink.OPEN_SHARE.dev\"")
      manifestPlaceholders["companionDeepLinkScheme"] = "olaink-player-dev"
      manifestPlaceholders["appLabel"] = "Ola Ink Dev"
    }
    getByName("release") {
      signingConfig = signingConfigs.getByName("release")
    }
  }
}

val validateReleaseSigning = tasks.register("validateReleaseSigning") {
  group = "verification"
  description = "Refuses release packaging without the persistent release signing key."
  doLast {
    val missing = releaseSigningInputs.filterValues { !it.isPresent }.keys
    if (missing.isNotEmpty()) {
      throw GradleException("Release signing requires: ${missing.joinToString(", ")}")
    }
    val keystore = file(releaseStoreFile.get())
    if (!keystore.isFile) throw GradleException("Release keystore does not exist: $keystore")
  }
}

tasks.matching { it.name == "preDebugBuild" }.configureEach {
  dependsOn(stageDebugPlugin)
}
tasks.named("buildOlainkPluginRelease").configure {
  mustRunAfter(validateReleaseSigning)
}
stageReleasePlugin.configure {
  dependsOn(validateReleaseSigning)
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach {
  dependsOn(stageReleasePlugin)
}

dependencies {
  implementation("androidx.webkit:webkit:1.12.1")
}
