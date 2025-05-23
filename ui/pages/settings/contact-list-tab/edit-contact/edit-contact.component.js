import React, { PureComponent } from 'react';
import PropTypes from 'prop-types';
import { Redirect } from 'react-router-dom';
import Identicon from '../../../../components/ui/identicon';
import Button from '../../../../components/ui/button/button.component';
import TextField from '../../../../components/ui/text-field';
import PageContainerFooter from '../../../../components/ui/page-container/page-container-footer';
import {
  isBurnAddress,
  isValidHexAddress,
} from '../../../../../shared/modules/hexstring-utils';
import {
  getHexAddressFromQtum,
} from '../../../../helpers/utils/util';

export default class EditContact extends PureComponent {
  static contextTypes = {
    t: PropTypes.func,
  };

  static propTypes = {
    addToAddressBook: PropTypes.func,
    removeFromAddressBook: PropTypes.func,
    history: PropTypes.object,
    name: PropTypes.string,
    address: PropTypes.string,
    chainId: PropTypes.string,
    memo: PropTypes.string,
    viewRoute: PropTypes.string,
    listRoute: PropTypes.string,
    qtumAddress: PropTypes.string,
    isQtumAddressShow: PropTypes.bool,
  };

  static defaultProps = {
    name: '',
    memo: '',
  };

  state = {
    newName: this.props.name,
    newAddress: this.props.isQtumAddressShow ? this.props.qtumAddress : this.props.address,
    newMemo: this.props.memo,
    error: '',
  };

  render() {
    const { t } = this.context;
    const {
      address,
      addToAddressBook,
      chainId,
      history,
      listRoute,
      memo,
      name,
      removeFromAddressBook,
      viewRoute,
    } = this.props;

    if (!address) {
      return <Redirect to={{ pathname: listRoute }} />;
    }

    return (
      <div className="settings-page__content-row address-book__edit-contact">
        <div className="settings-page__header address-book__header--edit">
          <Identicon address={address} diameter={60} />
          <Button
            type="link"
            className="settings-page__address-book-button"
            onClick={async () => {
              await removeFromAddressBook(chainId, address);
              history.push(listRoute);
            }}
          >
            {t('deleteAccount')}
          </Button>
        </div>
        <div className="address-book__edit-contact__content">
          <div className="address-book__view-contact__group">
            <div className="address-book__view-contact__group__label">
              {t('userName')}
            </div>
            <TextField
              type="text"
              id="nickname"
              placeholder={this.context.t('addAlias')}
              value={this.state.newName}
              onChange={(e) => this.setState({ newName: e.target.value })}
              fullWidth
              margin="dense"
            />
          </div>

          <div className="address-book__view-contact__group">
            <div className="address-book__view-contact__group__label">
              {t('ethereumPublicAddress')}
            </div>
            <TextField
              type="text"
              id="address"
              value={this.state.newAddress}
              error={this.state.error}
              onChange={(e) => this.setState({ newAddress: e.target.value })}
              fullWidth
              multiline
              rows={3}
              margin="dense"
              classes={{
                inputMultiline:
                  'address-book__view-contact__address__text-area',
                inputRoot: 'address-book__view-contact__address',
              }}
            />
          </div>

          <div className="address-book__view-contact__group">
            <div className="address-book__view-contact__group__label--capitalized">
              {t('memo')}
            </div>
            <TextField
              type="text"
              id="memo"
              placeholder={memo}
              value={this.state.newMemo}
              onChange={(e) => this.setState({ newMemo: e.target.value })}
              fullWidth
              margin="dense"
              multiline
              rows={3}
              classes={{
                inputMultiline: 'address-book__view-contact__text-area',
                inputRoot: 'address-book__view-contact__text-area-wrapper',
              }}
            />
          </div>
        </div>
        <PageContainerFooter
          cancelText={this.context.t('cancel')}
          onSubmit={async () => {
            if (
              this.state.newAddress !== '' &&
              this.state.newAddress !== address
            ) {
              // if the user makes a valid change to the address field, remove the original address
              const isHex = isValidHexAddress(this.state.newAddress, {
                mixedCaseUseChecksum: true,
              });
              const hex = isHex ?
                this.state.newAddress : getHexAddressFromQtum(this.state.newAddress);
              if (
                !isBurnAddress(hex)/* &&
                isValidHexAddress(this.state.newAddress, {
                  mixedCaseUseChecksum: true,
                })
                */
              ) {
                await removeFromAddressBook(chainId, address);
                await addToAddressBook(
                  hex,
                  this.state.newName || name,
                  this.state.newMemo || memo,
                );
                history.push(listRoute);
              } else {
                this.setState({ error: this.context.t('invalidAddress') });
              }
            } else {
              // update name
              await addToAddressBook(
                address,
                this.state.newName || name,
                this.state.newMemo || memo,
              );
              history.push(listRoute);
            }
          }}
          onCancel={() => {
            history.push(`${viewRoute}/${address}`);
          }}
          submitText={this.context.t('save')}
        />
      </div>
    );
  }
}
