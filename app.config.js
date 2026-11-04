const IS_DEV = process.env.APP_VARIANT === 'development';

export default {
  name: IS_DEV ? 'Abacus.dev' : 'Abacus',
  description: 'Abacus: Firefly III mobile application.',
  slug: 'abacus',
  privacy: 'public',
  platforms: [
    'ios',
    'android',
  ],
  version: '0.25.0',
  orientation: 'portrait',
  updates: {
    enabled: false,
  },
  ios: {
    icon: './src/images/icon-abacus.png',
    splash: {
      image: './src/images/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
      dark: {
        backgroundColor: '#121215',
      },
    },
    supportsTablet: true,
    infoPlist: {
      NSFaceIDUsageDescription: 'Abacus use Authentication with TouchId or FaceID',
      NSLocalNetworkUsageDescription: 'Abacus use Local Network to access Firefly III on your local network',
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
    },
    config: {
      usesNonExemptEncryption: false,
    },
    bundleIdentifier: IS_DEV ? 'abacus.fireflyiii.ios.app.dev' : 'abacus.ios.app',
    buildNumber: '0.25.0',
  },
  android: {
    icon: './src/images/icon-abacus.png',
    adaptiveIcon: {
      foregroundImage: './src/images/icon-abacus-foreground.png',
      backgroundImage: './src/images/icon-abacus-background.png',
    },
    splash: {
      image: './src/images/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#ffffff',
      dark: {
        backgroundColor: '#121215',
      },
    },
    playStoreUrl: 'https://play.google.com/store/apps/details?id=abacus.fireflyiii.android.liaocl',
    package: IS_DEV ? 'abacus.fireflyiii.android.liaocl.dev' : 'abacus.fireflyiii.android.liaocl',
    versionCode: 41,
  },
  scheme: 'abacusfiiiapp',
  githubUrl: 'https://github.com/victorbalssa/abacus',
  runtimeVersion: {
    policy: 'sdkVersion',
  },
  plugins: [
    'expo-asset',
    'expo-secure-store',
    'expo-localization',
    './plugins/withAndroidManifest',
    './plugins/withReleaseSigning',
    './plugins/withGradleMemory',
    [
      'expo-build-properties',
      {
        android: {
          minSdkVersion: 31,
        },
      },
    ],
    [
      'expo-font',
      {
        fonts: [
          './src/fonts/Montserrat-Bold.ttf',
          './src/fonts/Montserrat-Regular.ttf',
          './src/fonts/Montserrat-Light.ttf',
        ],
      },
    ],
    [
      'expo-quick-actions',
      {
        androidIcons: {
          shortcut_add: {
            foregroundImage: './src/images/icon-adaptive-add.png',
            backgroundColor: '#FF5533',
          },
        },
      },
    ],
  ],
  userInterfaceStyle: 'automatic',
};
