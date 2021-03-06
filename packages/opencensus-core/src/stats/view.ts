/**
 * Copyright 2018, OpenCensus Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as defaultLogger from '../common/console-logger';
import {getTimestampWithProcessHRTime, timestampFromMillis} from '../common/time-util';
import * as loggerTypes from '../common/types';
import {DistributionValue, LabelValue, Metric, MetricDescriptor, MetricDescriptorType, Point, TimeSeries, Timestamp} from '../metrics/export/types';
import {TagMap} from '../tags/tag-map';
import {TagKey, TagValue} from '../tags/types';
import {isValidTagKey} from '../tags/validation';
import {BucketBoundaries} from './bucket-boundaries';
import {MetricUtils} from './metric-utils';
import {Recorder} from './recorder';
import {AggregationData, AggregationType, Measure, Measurement, View} from './types';

const RECORD_SEPARATOR = String.fromCharCode(30);

export class BaseView implements View {
  /**
   * A string by which the View will be referred to, e.g. "rpc_latency". Names
   * MUST be unique within the library.
   */
  readonly name: string;
  /** Describes the view, e.g. "RPC latency distribution" */
  readonly description: string;
  /** The Measure to which this view is applied. */
  readonly measure: Measure;
  /**
   * A map of stringified tags representing columns labels or tag keys, concept
   * similar to dimensions on multidimensional modeling, to AggregationData.
   * If no Tags are provided, then, all data is recorded in a single
   * aggregation.
   */
  private tagValueAggregationMap: {[key: string]: AggregationData} = {};
  /**
   * A list of tag keys that represents the possible column labels
   */
  private columns: TagKey[];
  /**
   * An Aggregation describes how data collected is aggregated.
   * There are four aggregation types: count, sum, lastValue and distirbution.
   */
  readonly aggregation: AggregationType;
  /** The start time for this view */
  readonly startTime: number;
  /** The bucket boundaries in a Distribution Aggregation */
  private bucketBoundaries: BucketBoundaries;
  /**
   * Cache a MetricDescriptor to avoid converting View to MetricDescriptor
   * in the future.
   */
  private metricDescriptor: MetricDescriptor;
  /**
   * The end time for this view - represents the last time a value was recorded
   */
  endTime: number;
  /** true if the view was registered */
  registered = false;
  /** An object to log information to */
  // @ts-ignore
  private logger: loggerTypes.Logger;
  /**
   * Creates a new View instance. This constructor is used by Stats. User should
   * prefer using Stats.createView() instead.
   * @param name The view name
   * @param measure The view measure
   * @param aggregation The view aggregation type
   * @param tagsKeys The Tags' keys that view will have
   * @param description The view description
   * @param bucketBoundaries The view bucket boundaries for a distribution
   * aggregation type
   * @param logger
   */
  constructor(
      name: string, measure: Measure, aggregation: AggregationType,
      tagsKeys: TagKey[], description: string, bucketBoundaries?: number[],
      logger = defaultLogger) {
    if (aggregation === AggregationType.DISTRIBUTION && !bucketBoundaries) {
      throw new Error('No bucketBoundaries specified');
    }
    this.logger = logger.logger();
    this.name = name;
    this.description = description;
    this.measure = measure;
    this.columns = this.validateTagKeys(tagsKeys);
    this.aggregation = aggregation;
    this.startTime = Date.now();
    this.bucketBoundaries = new BucketBoundaries(bucketBoundaries);
    this.metricDescriptor = MetricUtils.viewToMetricDescriptor(this);
  }

  /** Gets the view's tag keys */
  getColumns(): TagKey[] {
    return this.columns;
  }

  /**
   * Records a measurement in the proper view's row. This method is used by
   * Stats. User should prefer using Stats.record() instead.
   *
   * Measurements with measurement type INT64 will have its value truncated.
   * @param measurement The measurement to record
   * @param tags The tags to which the value is applied
   */
  recordMeasurement(measurement: Measurement, tags: TagMap) {
    const tagValues = Recorder.getTagValues(tags.tags, this.columns);
    const encodedTags = this.encodeTagValues(tagValues);
    if (!this.tagValueAggregationMap[encodedTags]) {
      this.tagValueAggregationMap[encodedTags] =
          this.createAggregationData(tagValues);
    }

    Recorder.addMeasurement(
        this.tagValueAggregationMap[encodedTags], measurement);
  }

  /**
   * Encodes a TagValue object into a value sorted string.
   * @param tagValues The tagValues to encode
   */
  private encodeTagValues(tagValues: TagValue[]): string {
    return tagValues.map((tagValue) => tagValue ? tagValue.value : null)
        .sort()
        .join(RECORD_SEPARATOR);
  }

  /**
   * Creates an empty aggregation data for a given tags.
   * @param tagValues The tags for that aggregation data
   */
  private createAggregationData(tagValues: TagValue[]): AggregationData {
    const aggregationMetadata = {tagValues, timestamp: Date.now()};
    const {buckets, bucketCounts} = this.bucketBoundaries;
    const bucketsCopy = Object.assign([], buckets);
    const bucketCountsCopy = Object.assign([], bucketCounts);

    switch (this.aggregation) {
      case AggregationType.DISTRIBUTION:
        return {
          ...aggregationMetadata,
          type: AggregationType.DISTRIBUTION,
          startTime: this.startTime,
          count: 0,
          sum: 0,
          mean: null as number,
          stdDeviation: null as number,
          sumOfSquaredDeviation: null as number,
          buckets: bucketsCopy,
          bucketCounts: bucketCountsCopy
        };
      case AggregationType.SUM:
        return {...aggregationMetadata, type: AggregationType.SUM, value: 0};
      case AggregationType.COUNT:
        return {...aggregationMetadata, type: AggregationType.COUNT, value: 0};
      default:
        return {
          ...aggregationMetadata,
          type: AggregationType.LAST_VALUE,
          value: undefined
        };
    }
  }

  /**
   * Gets view`s metric
   * @param start The start timestamp in epoch milliseconds
   * @returns {Metric}
   */
  getMetric(start: number): Metric {
    const {type} = this.metricDescriptor;
    let startTimestamp: Timestamp;

    // The moment when this point was recorded.
    const now: Timestamp = getTimestampWithProcessHRTime();

    switch (type) {
      case MetricDescriptorType.GAUGE_INT64:
      case MetricDescriptorType.GAUGE_DOUBLE:
        startTimestamp = null;
        break;
      default:
        startTimestamp = timestampFromMillis(start);
    }

    const timeseries: TimeSeries[] = [];

    Object.keys(this.tagValueAggregationMap).forEach(key => {
      const {tagValues} = this.tagValueAggregationMap[key];
      const labelValues: LabelValue[] =
          MetricUtils.tagValuesToLabelValues(tagValues);
      const point: Point = this.toPoint(now, this.getSnapshot(tagValues));

      if (startTimestamp) {
        timeseries.push({startTimestamp, labelValues, points: [point]});
      } else {
        timeseries.push({labelValues, points: [point]});
      }
    });

    return {descriptor: this.metricDescriptor, timeseries};
  }

  /**
   * Converts snapshot to point
   * @param timestamp The timestamp
   * @param data The aggregated data
   * @returns {Point}
   */
  private toPoint(timestamp: Timestamp, data: AggregationData): Point {
    let value;

    if (data.type === AggregationType.DISTRIBUTION) {
      // TODO: Add examplar transition
      const {count, sum, sumOfSquaredDeviation} = data;
      value = {
        count,
        sum,
        sumOfSquaredDeviation,
        bucketOptions: {explicit: {bounds: data.buckets}},
        // Bucket without an Exemplar.
        buckets:
            data.bucketCounts.map(bucketCount => ({count: bucketCount}))
      } as DistributionValue;
    } else {
      value = data.value as number;
    }
    return {timestamp, value};
  }

  /**
   * Returns a snapshot of an AggregationData for that tags/labels values.
   * @param tags The desired data's tags
   * @returns {AggregationData}
   */
  getSnapshot(tagValues: TagValue[]): AggregationData {
    return this.tagValueAggregationMap[this.encodeTagValues(tagValues)];
  }

  /** Determines whether the given TagKeys are valid. */
  private validateTagKeys(tagKeys: TagKey[]): TagKey[] {
    const tagKeysCopy = Object.assign([], tagKeys);
    tagKeysCopy.forEach((tagKey) => {
      if (!isValidTagKey(tagKey)) {
        throw new Error(`Invalid TagKey name: ${tagKey}`);
      }
    });
    const tagKeysSet = new Set(tagKeysCopy.map(tagKey => tagKey.name));
    if (tagKeysSet.size !== tagKeysCopy.length) {
      throw new Error('Columns have duplicate');
    }
    return tagKeysCopy;
  }
}
