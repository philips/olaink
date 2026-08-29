import React, { useEffect, useState } from 'react';
import { NativeModules, Pressable, requireNativeComponent, ScrollView, StyleSheet, Text, View } from 'react-native';
import { PluginManager } from 'sn-plugin-lib';

const AnimatedSvgScene = requireNativeComponent('OlaInkAnimatedSvgScene');
const AnimatedSvgRasterWipe = requireNativeComponent('OlaInkAnimatedSvgRasterWipe');
const AnimatedSvgPageTurn = requireNativeComponent('OlaInkAnimatedSvgPageTurn');
const AnimatedSvgDocument = requireNativeComponent('OlaInkAnimatedSvgDocument');
const { documents } = require('./fixtures/documents.json');

const EXPERIMENTS = [
  { technique: 'prefix', durationMs: 6000, framesPerSecond: 10, hostFps: 10, label: 'Prefix redraw · 6 sec / 10 FPS', detail: 'Baseline: redraws the entire revealed stroke every frame.' },
  { technique: 'incremental', durationMs: 6000, framesPerSecond: 10, hostFps: 10, label: 'Incremental ink · 6 sec / 10 FPS', detail: 'Appends each new stroke segment; completed ink is never cleared during the replay.' },
  { technique: 'cursor', durationMs: 6000, framesPerSecond: 10, hostFps: 10, label: 'Moving cursor · 6 sec / 10 FPS', detail: 'A stable grey trace plus a short black pen head changes the fewest pixels.' },
  { technique: 'incremental', durationMs: 6000, framesPerSecond: 5, hostFps: 5, label: 'Incremental ink · 6 sec / 5 FPS', detail: 'Tests fewer host/e-ink refreshes and larger visible steps.' },
  { technique: 'cursor', durationMs: 8000, framesPerSecond: 10, hostFps: 5, label: 'Moving cursor · 8 sec / host 5 FPS', detail: 'Native path ticks at 10 FPS while PluginHost refresh is requested only at 5 FPS.' },
  { kind: 'raster', hostFps: 10, label: 'Supplied raster SVG · 8 sec / 10 FPS', detail: 'Honest top-to-bottom reveal of its embedded PNG; it cannot replay unavailable pen strokes.' },
  { kind: 'pageTurn', hostFps: 10, label: 'Two-page turn · 4 sec page + 1 sec hold', detail: 'Detects completed drawing, holds the complete page for 1000 ms, then starts the next page in the same viewport.' },
];

const DOC_HOST_FPS = 10;
const SPEEDS = [1, 2, 5, 10];

export default function App() {
  const [mode, setMode] = useState('lab');
  const [experimentIndex, setExperimentIndex] = useState(0);
  const [documentIndex, setDocumentIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [restartToken, setRestartToken] = useState(0);
  const experiment = EXPERIMENTS[experimentIndex];
  const document = documents[documentIndex];

  useEffect(() => {
    if (!playing) return undefined;
    const hostFps = mode === 'lab' ? experiment.hostFps : DOC_HOST_FPS;
    if (hostFps <= 0) return undefined;
    const nativePluginManager = NativeModules.NativePluginManager;
    const refresh = () => nativePluginManager?.invalidatePluginView?.();
    refresh();
    const timer = setInterval(refresh, Math.round(1000 / hostFps));
    return () => clearInterval(timer);
  }, [mode, experiment, playing, restartToken, documentIndex]);

  const selectExperiment = index => {
    setMode('lab');
    setExperimentIndex(index);
    setRestartToken(value => value + 1);
  };

  const selectDocument = index => {
    setMode('docs');
    setDocumentIndex(index);
    setRestartToken(value => value + 1);
  };

  const selectMode = next => {
    setMode(next);
    setRestartToken(value => value + 1);
  };

  return (
    <View style={styles.root}>
      <View style={styles.tabs}>
        <Pressable style={[styles.tab, mode === 'lab' && styles.tabActive]} onPress={() => selectMode('lab')}>
          <Text style={styles.tabText}>Lab techniques</Text>
        </Pressable>
        <Pressable style={[styles.tab, mode === 'docs' && styles.tabActive]} onPress={() => selectMode('docs')}>
          <Text style={styles.tabText}>Fixture documents ({documents.length})</Text>
        </Pressable>
      </View>
      {mode === 'docs' ? (
        <>
          <Text style={styles.docTitle}>{document.title}</Text>
          <Text style={styles.docDetail}>
            {document.pages.length} page{document.pages.length > 1 ? 's' : ''} · write-order replay · 1000 ms hold between pages
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.title}>E-ink animation techniques</Text>
          <Text style={styles.selected}>{experiment.label}</Text>
          <Text style={styles.detail}>{experiment.detail}</Text>
        </>
      )}
      <View style={mode === 'docs' ? styles.docFrame : styles.frame}>
        {mode === 'docs' ? (
          <AnimatedSvgDocument
            style={styles.scene}
            pagesJson={JSON.stringify(document.pages)}
            title={document.title}
            playbackSpeed={playbackSpeed}
            playing={playing}
            restartToken={restartToken}
          />
        ) : experiment.kind === 'raster' ? (
          <AnimatedSvgRasterWipe style={styles.scene} playing={playing} restartToken={restartToken} />
        ) : experiment.kind === 'pageTurn' ? (
          <AnimatedSvgPageTurn style={styles.scene} playing={playing} restartToken={restartToken} />
        ) : (
          <AnimatedSvgScene
            style={styles.scene}
            technique={experiment.technique}
            durationMs={experiment.durationMs}
            framesPerSecond={experiment.framesPerSecond}
            playing={playing}
            restartToken={restartToken}
          />
        )}
      </View>
      <View style={styles.controls}>
        <Pressable style={styles.button} onPress={() => setPlaying(value => !value)}>
          <Text style={styles.buttonText}>{playing ? 'Pause' : 'Resume'}</Text>
        </Pressable>
        <Pressable style={styles.button} onPress={() => setRestartToken(value => value + 1)}>
          <Text style={styles.buttonText}>Replay</Text>
        </Pressable>
        {mode === 'docs' && (
          <Pressable
            style={styles.button}
            onPress={() => setPlaybackSpeed(value => SPEEDS[(SPEEDS.indexOf(value) + 1) % SPEEDS.length])}
          >
            <Text style={styles.buttonText}>Speed {playbackSpeed}x</Text>
          </Pressable>
        )}
      </View>
      <ScrollView style={mode === 'docs' ? styles.docList : styles.choices} contentContainerStyle={styles.listContent}>
        {(mode === 'docs' ? documents : EXPERIMENTS).map((item, index) => {
          const selected = mode === 'docs' ? index === documentIndex : index === experimentIndex;
          const label = mode === 'docs'
            ? `${index + 1}. ${item.title} (${item.pages.length}p)`
            : `${index + 1}. ${item.label}`;
          return (
            <Pressable
              key={item.id || item.label}
              style={[styles.choice, selected && styles.choiceActive]}
              onPress={() => (mode === 'docs' ? selectDocument(index) : selectExperiment(index))}
            >
              <Text style={styles.choiceText}>{label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {mode === 'lab' && (
        <Text style={styles.note}>Compare flashing, ghosting, readability, and whether the pen motion feels continuous. These are rendering experiments only.</Text>
      )}
      <Pressable style={styles.close} onPress={() => PluginManager.closePluginView()}>
        <Text style={styles.closeText}>Close probe</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#f7f4ed', flex: 1, padding: 14 },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: { borderColor: '#9b968c', borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  tabActive: { backgroundColor: '#dedad1', borderColor: '#000000' },
  tabText: { color: '#000000', fontSize: 14, fontWeight: '700' },
  title: { color: '#000000', fontSize: 22, fontWeight: '700', marginTop: 8 },
  selected: { color: '#000000', fontSize: 16, fontWeight: '700', marginTop: 6 },
  detail: { color: '#28251f', fontSize: 13, lineHeight: 17, marginTop: 2 },
  docTitle: { color: '#000000', fontSize: 16, fontWeight: '700', marginTop: 8 },
  docDetail: { color: '#28251f', fontSize: 12, marginTop: 2 },
  frame: { borderColor: '#000000', borderWidth: 1, height: 340, marginTop: 10, width: '100%' },
  docFrame: { borderColor: '#000000', borderWidth: 1, flex: 1, marginTop: 8, width: '100%' },
  scene: { flex: 1 },
  controls: { flexDirection: 'row', gap: 12, marginTop: 8 },
  button: { borderColor: '#000000', borderWidth: 1, paddingHorizontal: 16, paddingVertical: 8 },
  buttonText: { color: '#000000', fontSize: 15 },
  choices: { marginTop: 10 },
  docList: { marginTop: 8, maxHeight: 132, borderColor: '#9b968c', borderWidth: 1 },
  listContent: { gap: 6, padding: 4 },
  choice: { borderColor: '#9b968c', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  choiceActive: { backgroundColor: '#dedad1', borderColor: '#000000' },
  choiceText: { color: '#000000', fontSize: 12 },
  note: { color: '#28251f', fontSize: 12, lineHeight: 16, marginTop: 8 },
  close: { alignSelf: 'flex-start', marginTop: 4, paddingVertical: 4 },
  closeText: { color: '#000000', fontSize: 16, textDecorationLine: 'underline' },
});
