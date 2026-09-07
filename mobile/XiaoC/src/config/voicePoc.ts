import * as Application from 'expo-application';
import Constants from 'expo-constants';

const VOICE_POC_BUNDLE_ID = 'com.hxj.xiaoc.voicepoc';

// The native bundle ID remains stable even when a development client connects
// to a Metro server whose manifest was started without the PoC environment flag.
export const isVoicePocBuild = __DEV__ && (
  Application.applicationId === VOICE_POC_BUNDLE_ID ||
  Constants.expoConfig?.extra?.voicePoc === true
);
