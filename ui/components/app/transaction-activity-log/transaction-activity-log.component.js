import React, { PureComponent } from 'react';
import PropTypes from 'prop-types';
import classnames from 'classnames';
import { stripHexPrefix } from 'ethereumjs-util';

import { getBlockExplorerLink } from '@metamask/etherscan-link';
import {
  getEthConversionFromWeiHex,
  getValueFromWeiHex,
} from '../../../helpers/utils/conversions.util';
import { formatDate, getURLHostName } from '../../../helpers/utils/util';
import { EVENT } from '../../../../shared/constants/metametrics';
import TransactionActivityLogIcon from './transaction-activity-log-icon';
import { CONFIRMED_STATUS } from './transaction-activity-log.constants';

const enableSpeedUp = false;

export default class TransactionActivityLog extends PureComponent {
  static contextTypes = {
    t: PropTypes.func,
    trackEvent: PropTypes.func,
  };

  static propTypes = {
    activities: PropTypes.array,
    className: PropTypes.string,
    conversionRate: PropTypes.number,
    inlineRetryIndex: PropTypes.number,
    inlineCancelIndex: PropTypes.number,
    nativeCurrency: PropTypes.string,
    onCancel: PropTypes.func,
    onRetry: PropTypes.func,
    primaryTransaction: PropTypes.object,
    isEarliestNonce: PropTypes.bool,
    rpcPrefs: PropTypes.object,
  };

  handleActivityClick = (activity) => {
    const { rpcPrefs } = this.props;
    const etherscanUrl = getBlockExplorerLink({ hash: stripHexPrefix(activity.hash), chainId: activity.chainId }, rpcPrefs);

    this.context.trackEvent({
      category: EVENT.CATEGORIES.TRANSACTIONS,
      event: 'Clicked Block Explorer Link',
      properties: {
        link_type: 'Transaction Block Explorer',
        action: 'Activity Details',
        block_explorer_domain: getURLHostName(etherscanUrl),
      },
    });

    global.platform.openTab({ url: etherscanUrl });
  };

  renderInlineRetry(index) {
    const { t } = this.context;
    const {
      inlineRetryIndex,
      primaryTransaction = {},
      onRetry,
      isEarliestNonce,
    } = this.props;
    const { status } = primaryTransaction;

    return isEarliestNonce &&
      status !== CONFIRMED_STATUS &&
      enableSpeedUp &&
      index === inlineRetryIndex ? (
      <div className="transaction-activity-log__action-link" onClick={onRetry}>
        {t('speedUpTransaction')}
      </div>
    ) : null;
  }

  renderInlineCancel(index) {
    const { t } = this.context;
    const {
      inlineCancelIndex,
      primaryTransaction = {},
      onCancel,
      isEarliestNonce,
    } = this.props;
    const { status } = primaryTransaction;

    return isEarliestNonce &&
      status !== CONFIRMED_STATUS &&
      enableSpeedUp &&
      index === inlineCancelIndex ? (
      <div className="transaction-activity-log__action-link" onClick={onCancel}>
        {t('speedUpCancellation')}
      </div>
    ) : null;
  }

  renderActivity(activity, index) {
    const { conversionRate, nativeCurrency } = this.props;
    const { eventKey, value, timestamp } = activity;
    const ethValue =
      index === 0
        ? `${getValueFromWeiHex({
            value,
            fromCurrency: 'QTUM',
            toCurrency: 'QTUM',
            conversionRate,
            numberOfDecimals: 6,
          })} ${nativeCurrency}`
        : getEthConversionFromWeiHex({
            value,
            fromCurrency: 'QTUM',
            conversionRate,
            numberOfDecimals: 3,
          });
    const formattedTimestamp = formatDate(timestamp, "T 'on' M/d/y");
    const activityText = this.context.t(eventKey, [
      ethValue,
      formattedTimestamp,
    ]);

    return (
      <div key={index} className="transaction-activity-log__activity">
        <TransactionActivityLogIcon
          className="transaction-activity-log__activity-icon"
          eventKey={eventKey}
        />
        <div className="transaction-activity-log__entry-container">
          <div
            className="transaction-activity-log__activity-text"
            title={activityText}
            onClick={() => this.handleActivityClick(activity)}
          >
            {activityText}
          </div>
          {this.renderInlineRetry(index)}
          {this.renderInlineCancel(index)}
        </div>
      </div>
    );
  }

  render() {
    const { t } = this.context;
    const { className, activities } = this.props;

    if (activities.length === 0) {
      return null;
    }

    return (
      <div className={classnames('transaction-activity-log', className)}>
        <div className="transaction-activity-log__title">
          {t('activityLog')}
        </div>
        <div className="transaction-activity-log__activities-container">
          {activities.map((activity, index) =>
            this.renderActivity(activity, index),
          )}
        </div>
      </div>
    );
  }
}
