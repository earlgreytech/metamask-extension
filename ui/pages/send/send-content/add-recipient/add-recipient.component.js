import React, { Component } from 'react';
import PropTypes from 'prop-types';
import Fuse from 'fuse.js';
import Identicon from '../../../../components/ui/identicon';
import Dialog from '../../../../components/ui/dialog';
import ContactList from '../../../../components/app/contact-list';
import RecipientGroup from '../../../../components/app/contact-list/recipient-group/recipient-group.component';
import { ellipsify } from '../../send.utils';
import Button from '../../../../components/ui/button';
import IconCaretLeft from '../../../../components/ui/icon/icon-caret-left';
import Confusable from '../../../../components/ui/confusable';

export default class AddRecipient extends Component {
  static propTypes = {
    userInput: PropTypes.string,
    ownedAccounts: PropTypes.array,
    addressBook: PropTypes.array,
    qtumAddressBook: PropTypes.object,
    isQtumAddressShowCheck: PropTypes.bool,
    updateRecipient: PropTypes.func,
    ensResolution: PropTypes.string,
    ensError: PropTypes.string,
    ensWarning: PropTypes.string,
    addressBookEntryName: PropTypes.string,
    contacts: PropTypes.array,
    nonContacts: PropTypes.array,
    addHistoryEntry: PropTypes.func,
    useMyAccountsForRecipientSearch: PropTypes.func,
    useContactListForRecipientSearch: PropTypes.func,
    isUsingMyAccountsForRecipientSearch: PropTypes.bool,
    recipient: PropTypes.shape({
      address: PropTypes.string,
      nickname: PropTypes.nickname,
      error: PropTypes.string,
      warning: PropTypes.string,
    }),
    updateRecipientUserInput: PropTypes.func,
  };

  constructor(props) {
    super(props);
    this.recentFuse = new Fuse(props.nonContacts, {
      shouldSort: true,
      threshold: 0.45,
      location: 0,
      distance: 100,
      maxPatternLength: 32,
      minMatchCharLength: 1,
      keys: [{ name: 'address', weight: 0.5 }],
    });

    this.contactFuse = new Fuse(props.contacts, {
      shouldSort: true,
      threshold: 0.45,
      location: 0,
      distance: 100,
      maxPatternLength: 32,
      minMatchCharLength: 1,
      keys: [
        { name: 'name', weight: 0.5 },
        { name: 'address', weight: 0.5 },
      ],
    });
  }

  static contextTypes = {
    t: PropTypes.func,
    metricsEvent: PropTypes.func,
  };

  selectRecipient = (address, nickname = '', type = 'user input') => {
    this.props.addHistoryEntry(
      `sendFlow - User clicked recipient from ${type}. address: ${address}, nickname ${nickname}`,
    );
    this.props.updateRecipient({ address, nickname });
    this.props.updateRecipientUserInput(address);
  };

  searchForContacts = () => {
    const { userInput, contacts } = this.props;

    let _contacts = contacts;

    if (userInput) {
      this.contactFuse.setCollection(contacts);
      _contacts = this.contactFuse.search(userInput);
    }

    return _contacts;
  };

  searchForRecents = () => {
    const { userInput, nonContacts } = this.props;

    let _nonContacts = nonContacts;

    if (userInput) {
      this.recentFuse.setCollection(nonContacts);
      _nonContacts = this.recentFuse.search(userInput);
    }

    return _nonContacts;
  };

  render() {
    const {
      ensResolution,
      recipient,
      userInput,
      addressBookEntryName,
      isUsingMyAccountsForRecipientSearch,
    } = this.props;

    let content;

    if (recipient.address) {
      content = this.renderExplicitAddress(
        recipient.address,
        recipient.nickname,
        'validated user input',
      );
    } else if (ensResolution && !recipient.error) {
      content = this.renderExplicitAddress(
        ensResolution,
        addressBookEntryName || userInput,
        'ENS resolution',
      );
    } else if (isUsingMyAccountsForRecipientSearch) {
      content = this.renderTransfer();
    }

    return (
      <div className="send__select-recipient-wrapper">
        {this.renderDialogs()}
        {content || this.renderMain()}
      </div>
    );
  }

  renderExplicitAddress(address, name, type) {
    const { qtumAddressBook, isQtumAddressShowCheck } = this.props;

    return (
      <div
        key={address}
        className="send__select-recipient-wrapper__group-item"
        onClick={() => this.selectRecipient(address, name, type)}
      >
        <Identicon address={address} diameter={28} />
        <div className="send__select-recipient-wrapper__group-item__content">
          <div className="send__select-recipient-wrapper__group-item__title">
            {name ? (
              <Confusable input={name} />
            ) : isQtumAddressShowCheck ? (
              qtumAddressBook[address]
            ) : (
              ellipsify(address)
            )}
          </div>
          {name && (
            <div className="send__select-recipient-wrapper__group-item__subtitle">
              {isQtumAddressShowCheck
                ? qtumAddressBook[address]
                : ellipsify(address)}
            </div>
          )}
        </div>
      </div>
    );
  }

  renderTransfer() {
    let { ownedAccounts } = this.props;
    const {
      userInput,
      qtumAddressBook,
      isQtumAddressShowCheck,
      useContactListForRecipientSearch,
      isUsingMyAccountsForRecipientSearch,
    } = this.props;
    const { t } = this.context;

    if (isUsingMyAccountsForRecipientSearch && userInput) {
      ownedAccounts = ownedAccounts.filter(
        (item) =>
          item.name.toLowerCase().indexOf(userInput.toLowerCase()) > -1 ||
          item.address.toLowerCase().indexOf(userInput.toLowerCase()) > -1,
      );
    }

    return (
      <div className="send__select-recipient-wrapper__list">
        <Button
          type="link"
          className="send__select-recipient-wrapper__list__link"
          onClick={useContactListForRecipientSearch}
        >
          <IconCaretLeft className="send__select-recipient-wrapper__list__back-caret" />
          {t('backToAll')}
        </Button>
        <RecipientGroup
          label={t('myAccounts')}
          items={ownedAccounts}
          qtumAddressBook={qtumAddressBook}
          isQtumAddressShowCheck={isQtumAddressShowCheck}
          onSelect={(address, name) =>
            this.selectRecipient(address, name, 'my accounts')
          }
        />
      </div>
    );
  }

  renderMain() {
    const { t } = this.context;
    const {
      userInput,
      ownedAccounts = [],
      addressBook,
      qtumAddressBook,
      isQtumAddressShowCheck,
      useMyAccountsForRecipientSearch,
    } = this.props;

    return (
      <div className="send__select-recipient-wrapper__list">
        <ContactList
          addressBook={addressBook}
          qtumAddressBook={qtumAddressBook}
          isQtumAddressShowCheck={isQtumAddressShowCheck}
          searchForContacts={this.searchForContacts.bind(this)}
          searchForRecents={this.searchForRecents.bind(this)}
          selectRecipient={(address, name) => {
            this.selectRecipient(
              address,
              name,
              `${name ? 'contact' : 'recent'} list`,
            );
          }}
        >
          {ownedAccounts && ownedAccounts.length > 1 && !userInput && (
            <Button
              type="link"
              className="send__select-recipient-wrapper__list__link"
              onClick={useMyAccountsForRecipientSearch}
            >
              {t('transferBetweenAccounts')}
            </Button>
          )}
        </ContactList>
      </div>
    );
  }

  renderDialogs() {
    const { ensError, recipient, ensWarning } = this.props;
    const { t } = this.context;

    if (ensError || (recipient.error && recipient.error !== 'required')) {
      return (
        <Dialog type="error" className="send__error-dialog">
          {t(ensError ?? recipient.error)}
        </Dialog>
      );
    } else if (ensWarning || recipient.warning) {
      return (
        <Dialog type="warning" className="send__error-dialog">
          {t(ensWarning ?? recipient.warning)}
        </Dialog>
      );
    }

    return null;
  }
}
