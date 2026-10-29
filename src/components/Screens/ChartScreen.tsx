import React, { useMemo, useRef } from 'react';
import { Animated, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PagerView, { PagerViewOnPageScrollEventData } from 'react-native-pager-view';
import { Entypo, Feather } from '@expo/vector-icons';

import { useThemeColors } from '../../lib/common';
import AssetsHistoryChart from '../Charts/AssetsHistoryChart';
import BalanceHistoryChart from '../Charts/BalanceHistoryChart';
import Pagination from '../UI/Pagination';
import SyncStatusBar from '../UI/SyncStatusBar';
import { AStack } from '../UI/ALibrary';

const AnimatedPagerView = Animated.createAnimatedComponent(PagerView);

export default function ChartScreen() {
  const { colors } = useThemeColors();
  const safeAreaInsets = useSafeAreaInsets();
  const viewPagerRef = useRef<PagerView>(null);
  const scrollOffsetAnimatedValue = React.useRef(new Animated.Value(0)).current;
  const positionAnimatedValue = React.useRef(new Animated.Value(0)).current;

  const renderIcons = [
    <Entypo key="line-graph" name="line-graph" size={20} color={colors.text} />,
    <Feather key="bar-chart-2" name="bar-chart-2" size={20} color={colors.text} />,
  ];

  return useMemo(() => (
    <View
      style={{
        flex: 1,
        paddingTop: safeAreaInsets.top + 53,
        backgroundColor: colors.backgroundColor,
        justifyContent: 'center',
      }}
    >
      <SyncStatusBar />
      <AStack px={5} py={5}>
        <Pagination
          renderIcons={renderIcons}
          handlePress={(index) => viewPagerRef?.current?.setPage(index)}
          scrollOffsetAnimatedValue={scrollOffsetAnimatedValue}
          positionAnimatedValue={positionAnimatedValue}
        />
      </AStack>

      <AnimatedPagerView
        ref={viewPagerRef}
        initialPage={0}
        style={{ flex: 1 }}
        scrollEnabled={false}
        onPageScroll={Animated.event<PagerViewOnPageScrollEventData>(
          [
            {
              nativeEvent: {
                offset: scrollOffsetAnimatedValue,
                position: positionAnimatedValue,
              },
            },
          ],
          {
            useNativeDriver: true,
          },
        )}
      >
        <AssetsHistoryChart key="1" />
        <BalanceHistoryChart key="2" />
      </AnimatedPagerView>
    </View>
  ), [colors]);
}
