import org.gradle.api.tasks.Copy
import org.gradle.api.tasks.Exec

plugins {
  id("com.android.application")
}

val repoRoot = rootProject.projectDir.parentFile
val pluginArchive = repoRoot.resolve("packages/plugin/build/outputs/olainkplugin.snplg")
val bundledPluginAssets = layout.buildDirectory.dir("generated/olaink-plugin-assets")

// The companion APK carries the exact .snplg built from this checkout. Building
// the APK therefore also rebuilds the plugin before staging it as an asset.
val buildOlainkPlugin = tasks.register<Exec>("buildOlainkPlugin") {
  workingDir = repoRoot
  commandLine("npm", "run", "build:plugin")
}
val stageOlainkPlugin = tasks.register<Copy>("stageOlainkPlugin") {
  dependsOn(buildOlainkPlugin)
  from(pluginArchive)
  into(bundledPluginAssets)
}

android {
  namespace = "dev.olaink.player"
  compileSdk = 35

  buildFeatures {
    buildConfig = true
  }

  sourceSets.getByName("main").assets.srcDir(bundledPluginAssets)

  defaultConfig {
    applicationId = "dev.olaink.player"
    minSdk = 23
    targetSdk = 35
    versionCode = 1
    versionName = "0.0.1"
  }
}

tasks.named("preBuild").configure {
  dependsOn(stageOlainkPlugin)
}

dependencies {
  implementation("androidx.webkit:webkit:1.12.1")
}
