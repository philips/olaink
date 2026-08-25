plugins {
  id("com.android.application")
}

android {
  namespace = "dev.wrtn.player"
  compileSdk = 35

  buildFeatures {
    buildConfig = true
  }

  defaultConfig {
    applicationId = "dev.wrtn.player"
    minSdk = 23
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }
}

dependencies {
  implementation("androidx.webkit:webkit:1.12.1")
}
