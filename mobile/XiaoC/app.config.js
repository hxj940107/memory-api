module.exports = ({ config }) => {
  if (process.env.XIAOC_VOICE_POC_BUILD !== '1') return config;
  if (process.env.EAS_BUILD_PROFILE && process.env.EAS_BUILD_PROFILE !== 'voice-poc') {
    throw new Error('Voice PoC must use the isolated voice-poc development profile');
  }
  return {
    ...config,
    name: 'XiaoC Voice PoC',
    scheme: 'xiaoc-voice-poc',
    ios: { ...config.ios, bundleIdentifier: 'com.hxj.xiaoc.voicepoc' },
    plugins: [
      ...(config.plugins || []),
      '@livekit/react-native-expo-plugin',
      ['@config-plugins/react-native-webrtc', {
        microphonePermission: '允许 XiaoC Voice PoC 在前台测试实时语音通话。',
      }],
    ],
    extra: { ...config.extra, voicePoc: true },
  };
};
