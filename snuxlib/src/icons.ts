import type { ImageSourcePropType } from 'react-native';

/**
 * Bundled 64x64 icons in the Supernote line style (black on transparent).
 * `require()`d so Metro copies them with `react-native bundle --assets-dest`.
 * Pass any of these (or your own `require('./x.png')`) as a tab `icon`.
 */
export const icons: Record<
  'close' | 'chevron' | 'back' | 'inbox' | 'send' | 'settings' | 'pair' | 'logs' | 'user',
  ImageSourcePropType
> = {
  close: require('../assets/icons/close.png'),
  chevron: require('../assets/icons/chevron.png'),
  back: require('../assets/icons/back.png'),
  inbox: require('../assets/icons/inbox.png'),
  send: require('../assets/icons/send.png'),
  settings: require('../assets/icons/settings.png'),
  pair: require('../assets/icons/pair.png'),
  logs: require('../assets/icons/logs.png'),
  user: require('../assets/icons/user.png'),
};
