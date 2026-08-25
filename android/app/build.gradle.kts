plugins {
  id("com.android.application")
}

android {
  namespace = "dev.olaink.player"
  compileSdk = 35

  buildFeatures {
    buildConfig = true
  }

  defaultConfig {
    applicationId = "dev.olaink.player"
    minSdk = 23
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }
}

dependencies {
  implementation("androidx.webkit:webkit:1.12.1")
}
