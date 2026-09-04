/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { DynamicColorIOS, Platform, PlatformColor } from 'react-native';

const dynamicColor = (light: string, dark: string) =>
  Platform.OS === 'ios' ? DynamicColorIOS({ light, dark }) : light;

const systemColor = (name: string, light: string) =>
  Platform.OS === 'ios' ? PlatformColor(name) : light;

export const XiaoCColors = {
  background: dynamicColor('#F9F9FB', '#171719'),
  navigationBackground: dynamicColor('rgba(249,249,251,0.88)', 'rgba(36,36,38,0.90)'),
  composerBackground: dynamicColor('rgba(249,249,251,0.78)', 'transparent'),
  surface: systemColor('secondarySystemBackgroundColor', '#F2F2F7'),
  textPrimary: systemColor('labelColor', '#1C1C1E'),
  textSecondary: systemColor('secondaryLabelColor', '#8E8E93'),
  placeholder: systemColor('placeholderTextColor', '#8E8E93'),
  separator: systemColor('separatorColor', 'rgba(60,60,67,0.29)'),
  userBubble: dynamicColor('#4A9EFF', '#347FCE'),
  assistantBubble: dynamicColor('#F0F0F5', '#303033'),
  voiceBubble: dynamicColor('#E8EEF6', '#292F38'),
  voiceBubblePressed: dynamicColor('#DDE7F2', '#323A46'),
  voiceWaveInactive: dynamicColor('rgba(52,127,206,0.30)', 'rgba(110,174,242,0.38)'),
  voiceDuration: dynamicColor('#68717D', '#B7C0CC'),
  inputSurface: dynamicColor('#FFFFFF', 'rgba(44,44,46,0.72)'),
  inputBorder: dynamicColor('rgba(60,60,67,0.18)', 'rgba(255,255,255,0.12)'),
  overlay: dynamicColor('rgba(0,0,0,0.10)', 'rgba(0,0,0,0.48)'),
  selected: systemColor('tertiarySystemFillColor', 'rgba(118,118,128,0.12)'),
  icon: systemColor('secondaryLabelColor', '#626267'),
  destructive: systemColor('systemRedColor', '#FF3B30'),
  sidebarMaterial: dynamicColor('rgba(248,248,250,0.96)', 'rgba(28,28,30,0.92)'),
  sidebarTitle: dynamicColor('#1C1C1E', '#F5F5F7'),
  sidebarSection: dynamicColor('#85858A', '#98989D'),
  sidebarText: dynamicColor('#343438', '#E5E5EA'),
  sidebarIcon: dynamicColor('#626267', '#98989D'),
  sidebarSelected: dynamicColor('rgba(118,118,128,0.10)', 'rgba(255,255,255,0.12)'),
  sidebarSeparator: dynamicColor('rgba(60,60,67,0.16)', 'rgba(255,255,255,0.12)'),
} as const;

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
